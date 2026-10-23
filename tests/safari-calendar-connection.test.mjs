import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Safari native bridge cancels late permission replies across handler instances', { skip: process.platform !== 'darwin' }, async () => {
  const source = await readFile('safari-native/SafariWebExtensionHandler.swift', 'utf8');
  const ensure = source.slice(source.indexOf('        case "ENSURE_CALENDAR":'), source.indexOf('        case "LIST_EVENTS":'));
  const disconnectStart = source.indexOf('        case "DISCONNECT":');
  const disconnect = source.slice(disconnectStart, source.indexOf('        default:', disconnectStart));
  const declarations = source.slice(source.indexOf('    private static let connectionLifecycleLock'), source.indexOf('    private let eventStore'));
  // Execute the production request handlers with deferred permission replies;
  // no EventKit access or changes to the user's calendars.
  const swift = `
import Foundation
final class Context { var data: Any?; var error: String? }
struct Calendar { let calendarIdentifier = "calendar"; let title = "Lectio" }
final class Harness {
${declarations}
    var permissionReplies: [(Result<Void, Error>) -> Void] = []
    var created = 0
    func requestCalendarAccess(interactive: Bool, completion: @escaping (Result<Void, Error>) -> Void) { permissionReplies.append(completion) }
    func ensureCalendar(currentIdentifier: String?, interactive: Bool, colorHex: String?) throws -> Calendar { created += 1; return Calendar() }
    func complete(_ context: Context, data: Any) { context.data = data }
    func complete(_ context: Context, error: String) { context.error = error }
    func receive(_ type: String, context: Context, message: [String: Any] = [:]) {
        switch type {
${ensure}
${disconnect}
        default: fatalError("unexpected request")
        }
    }
}
let loginHandler = Harness()
let disconnectHandler = Harness()
let cancelled = Context()
loginHandler.receive("ENSURE_CALENDAR", context: cancelled)
disconnectHandler.receive("DISCONNECT", context: Context())
loginHandler.permissionReplies.removeFirst()(.success(()))
precondition(loginHandler.created == 0 && cancelled.data == nil)
precondition(cancelled.error?.contains("cancelled") == true)
let fresh = Context()
loginHandler.receive("ENSURE_CALENDAR", context: fresh)
loginHandler.permissionReplies.removeFirst()(.success(()))
precondition(loginHandler.created == 1 && fresh.error == nil && fresh.data != nil)
print("Native permission cancellation and fresh retry passed")
`;
  const directory = await mkdtemp(join(tmpdir(), 'lectio-native-lifecycle-'));
  try {
    const path = join(directory, 'test.swift');
    await writeFile(path, swift);
    const result = spawnSync('swift', [path], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Native permission cancellation and fresh retry passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Safari calendar recovery handles stale IDs, multiple sources and ambiguous calendars without duplicates', { skip: process.platform !== 'darwin' }, async () => {
  const source = await readFile('safari-native/SafariWebExtensionHandler.swift', 'utf8');
  const method = source.slice(source.indexOf('    private func ensureCalendar('), source.indexOf('    private func apply(_ color:'))
    .replace('private func ensureCalendar(', 'func ensureCalendar(');
  // Execute the production selection code with an isolated store. Never access
  // EventKit or the user's calendars from a regression test.
  const swift = `
import Foundation
final class UserDefaults {
    static let standard = UserDefaults()
    var values: [String: String] = [:]
    func string(forKey key: String) -> String? { values[key] }
    func set(_ value: String, forKey key: String) { values[key] = value }
}
struct BridgeError: Error { let message: String; init(_ message: String) { self.message = message } }
final class EKSource { let sourceIdentifier: String; init(_ id: String) { sourceIdentifier = id } }
final class EKCalendar {
    var calendarIdentifier = UUID().uuidString
    var title = "Lectio"
    var source = EKSource("google")
    var allowsContentModifications = true
    var isSubscribed = false
    var cgColor: String = ""
    init(for type: EventType, eventStore: Store) {}
}
enum EventType { case event }
final class Store {
    var items: [EKCalendar] = []
    var created = 0
    var sources = [EKSource("google"), EKSource("other-google")]
    func refreshSourcesIfNecessary() {}
    func calendar(withIdentifier id: String) -> EKCalendar? { items.first { $0.calendarIdentifier == id } }
    func calendars(for type: EventType) -> [EKCalendar] { items }
    func source(withIdentifier id: String) -> EKSource? { sources.first { $0.sourceIdentifier == id } }
    func saveCalendar(_ calendar: EKCalendar, commit: Bool) throws { items.append(calendar); created += 1 }
    func reset() {}
}
final class Harness {
    static let calendarCreationLock = NSLock()
    let eventStore = Store()
    let calendarName = "Lectio"
    let ownedCalendarIdentifierKey = "owned"
    var failColor = false
    func calendarColor(from value: String) -> String? { value }
    func preferredGoogleSourceIdentifiers() -> [String] { eventStore.sources.map { $0.sourceIdentifier } }
    func isGoogleSource(_ source: EKSource) -> Bool { preferredGoogleSourceIdentifiers().contains(source.sourceIdentifier) }
    func apply(_ color: String?, to calendar: EKCalendar) throws { if failColor { throw BridgeError("colour failed") } }
${method}
}
func harness() -> Harness { UserDefaults.standard.values = [:]; return Harness() }
func calendar(_ h: Harness, source: String = "google") -> EKCalendar {
    let c = EKCalendar(for: .event, eventStore: h.eventStore); c.source = EKSource(source); h.eventStore.items.append(c); return c
}
func rejects(_ action: () throws -> Void) { do { try action(); fatalError("Expected refusal") } catch {} }
let multiSource = harness()
let existing = calendar(multiSource, source: "other-google")
let reused = try multiSource.ensureCalendar(currentIdentifier: nil, interactive: false, colorHex: nil)
precondition(reused === existing && multiSource.eventStore.created == 0)
let stale = harness()
UserDefaults.standard.set("stale", forKey: "owned")
rejects { _ = try stale.ensureCalendar(currentIdentifier: "stale", interactive: false, colorHex: nil) }
precondition(stale.eventStore.created == 0 && UserDefaults.standard.string(forKey: "owned") == "stale")
let ambiguous = harness()
_ = calendar(ambiguous); _ = calendar(ambiguous)
rejects { _ = try ambiguous.ensureCalendar(currentIdentifier: nil, interactive: true, colorHex: nil) }
precondition(ambiguous.eventStore.created == 0)
let current = harness()
let connected = calendar(current)
let restored = try current.ensureCalendar(currentIdentifier: connected.calendarIdentifier, interactive: false, colorHex: nil)
precondition(restored === connected)
let colour = harness()
let coloured = calendar(colour)
colour.failColor = true
rejects { _ = try colour.ensureCalendar(currentIdentifier: nil, interactive: true, colorHex: "#007AFF") }
precondition(UserDefaults.standard.string(forKey: "owned") == coloured.calendarIdentifier)
colour.failColor = false
_ = try colour.ensureCalendar(currentIdentifier: nil, interactive: true, colorHex: "#007AFF")
precondition(colour.eventStore.created == 0)
let initial = harness()
let created = try initial.ensureCalendar(currentIdentifier: nil, interactive: true, colorHex: nil)
let repeatCalendar = try initial.ensureCalendar(currentIdentifier: nil, interactive: false, colorHex: nil)
precondition(created === repeatCalendar && initial.eventStore.created == 1)
print("Six Safari calendar recovery scenarios passed")
`;
  const directory = await mkdtemp(join(tmpdir(), 'lectio-calendar-tests-'));
  try {
    const path = join(directory, 'test.swift');
    await writeFile(path, swift);
    const result = spawnSync('swift', [path], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Six Safari calendar recovery scenarios passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
