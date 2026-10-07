import EventKit
import CoreGraphics
import Foundation
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let calendarCreationLock = NSLock()
    private let eventStore = EKEventStore()
    private let calendarName = "Lectio"
    private let markerScheme = "lectiosync"
    private let ownedCalendarIdentifierKey = "LectioSyncOwnedCalendarIdentifierV1"
    private let maximumOperations = 500

    func beginRequest(with context: NSExtensionContext) {
        guard let request = context.inputItems.first as? NSExtensionItem,
              let message = extensionMessage(from: request) as? [String: Any],
              let type = message["type"] as? String else {
            complete(context, error: "The extension sent an invalid calendar request.")
            return
        }

        switch type {
        case "ENSURE_CALENDAR":
            let interactive = message["interactive"] as? Bool ?? false
            let calendarColor = message["calendarColor"] as? String
            requestCalendarAccess(interactive: interactive) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success:
                    do {
                        let calendar = try self.ensureCalendar(
                            currentIdentifier: message["currentCalendarId"] as? String,
                            interactive: interactive, colorHex: calendarColor
                        )
                        self.complete(context, data: [
                            "calendarId": calendar.calendarIdentifier,
                            "calendarName": calendar.title
                        ])
                    } catch {
                        self.complete(context, error: error.localizedDescription)
                    }
                case .failure(let error):
                    self.complete(context, error: error.localizedDescription)
                }
            }

        case "LIST_EVENTS":
            withAuthorizedCalendar(context: context, message: message) { calendar in
                guard let window = message["window"] as? [String: Any],
                      let timeMin = window["timeMin"] as? String,
                      let timeMax = window["timeMax"] as? String,
                      let start = self.parseInstant(timeMin),
                      let end = self.parseInstant(timeMax),
                      start < end else {
                    throw BridgeError("The calendar time window was invalid.")
                }

                let predicate = self.eventStore.predicateForEvents(
                    withStart: start,
                    end: end,
                    calendars: [calendar]
                )
                let events = self.eventStore.events(matching: predicate).compactMap { event -> [String: Any]? in
                    guard let id = event.eventIdentifier,
                          let marker = self.readMarker(from: event.url) else { return nil }
                    var result: [String: Any] = [
                        "id": id,
                        "sourceId": marker.sourceId
                    ]
                    if let fingerprint = marker.fingerprint { result["fingerprint"] = fingerprint }
                    if event.status == .canceled { result["status"] = "cancelled" }
                    return result
                }
                return events
            }

        case "APPLY_OPERATIONS":
            withAuthorizedCalendar(context: context, message: message) { calendar in
                guard let operations = message["operations"] as? [[String: Any]] else {
                    throw BridgeError("The calendar changes were invalid.")
                }
                return try self.apply(operations: operations, to: calendar)
            }

        case "DISCONNECT":
            complete(context, data: true)

        default:
            complete(context, error: "The requested calendar action is not supported.")
        }
    }

    private func withAuthorizedCalendar(
        context: NSExtensionContext,
        message: [String: Any],
        action: @escaping (EKCalendar) throws -> Any
    ) {
        requestCalendarAccess(interactive: false) { [weak self] result in
            guard let self else { return }
            do {
                try result.get()
                guard let calendarId = message["calendarId"] as? String,
                      let calendar = self.ownedCalendar(withIdentifier: calendarId) else {
                    throw BridgeError("The Lectio Google calendar is unavailable. Reconnect it in Lectio Sync.")
                }
                self.complete(context, data: try action(calendar))
            } catch {
                self.complete(context, error: error.localizedDescription)
            }
        }
    }

    private func requestCalendarAccess(
        interactive: Bool,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        let status = EKEventStore.authorizationStatus(for: .event)
        if isAuthorized(status) {
            completion(.success(()))
            return
        }
        if status == .denied || status == .restricted {
            completion(.failure(BridgeError("Calendar access is disabled. Allow it for Lectio Sync in System Settings.")))
            return
        }
        guard interactive else {
            completion(.failure(BridgeError("Calendar access is required. Open Lectio Sync and connect the calendar first.")))
            return
        }

        if #available(iOS 17.0, macOS 14.0, *) {
            eventStore.requestFullAccessToEvents { granted, error in
                self.finishAccessRequest(granted: granted, error: error, completion: completion)
            }
        } else {
            eventStore.requestAccess(to: .event) { granted, error in
                self.finishAccessRequest(granted: granted, error: error, completion: completion)
            }
        }
    }

    private func finishAccessRequest(
        granted: Bool,
        error: Error?,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        if granted {
            completion(.success(()))
        } else {
            completion(.failure(error ?? BridgeError("Calendar access was not granted.")))
        }
    }

    private func isAuthorized(_ status: EKAuthorizationStatus) -> Bool {
        if #available(iOS 17.0, macOS 14.0, *) {
            return status == .fullAccess
        }
        return status == .authorized
    }

    private func ensureCalendar(currentIdentifier: String?, interactive: Bool, colorHex: String?) throws -> EKCalendar {
        Self.calendarCreationLock.lock()
        defer { Self.calendarCreationLock.unlock() }
        eventStore.refreshSourcesIfNecessary()
        let desiredColor = colorHex.flatMap(calendarColor(from:))
        let storedIdentifier = UserDefaults.standard.string(forKey: ownedCalendarIdentifierKey)
        for identifier in [storedIdentifier, currentIdentifier].compactMap({ $0 }) {
            if let calendar = eventStore.calendar(withIdentifier: identifier),
               calendar.title == calendarName, isGoogleSource(calendar.source),
               calendar.allowsContentModifications, !calendar.isSubscribed {
                UserDefaults.standard.set(calendar.calendarIdentifier, forKey: ownedCalendarIdentifierKey)
                try apply(desiredColor, to: calendar)
                return calendar
            }
        }

        let sourceIdentifiers = preferredGoogleSourceIdentifiers()
        guard !sourceIdentifiers.isEmpty else {
            throw BridgeError("No Google Calendar account was found. Add Google in System Settings › Internet Accounts, then try again.")
        }

        // Search every Google source before creating anything in the first one.
        let existing = eventStore.calendars(for: .event).filter {
            sourceIdentifiers.contains($0.source.sourceIdentifier)
                && $0.title == calendarName && $0.allowsContentModifications && !$0.isSubscribed
        }
        guard existing.count <= 1 else {
            throw BridgeError("Multiple Lectio calendars were found under Google. Keep the calendar containing your timetable and resolve the duplicates before reconnecting.")
        }
        if let calendar = existing.first {
            UserDefaults.standard.set(calendar.calendarIdentifier, forKey: ownedCalendarIdentifierKey)
            try apply(desiredColor, to: calendar)
            return calendar
        }
        // A missing EventKit identifier may be temporary or changed by a full
        // account sync. Background sync and colour changes must not create replacements.
        guard interactive || (storedIdentifier == nil && currentIdentifier == nil) else {
            throw BridgeError("The saved Lectio calendar is temporarily unavailable. Refresh Apple Calendar and reconnect Lectio Sync before creating a replacement.")
        }

        for sourceIdentifier in sourceIdentifiers {
            guard let source = eventStore.source(withIdentifier: sourceIdentifier) else { continue }
            let calendar = EKCalendar(for: .event, eventStore: eventStore)
            calendar.title = calendarName
            calendar.source = source
            if #available(macOS 10.15, *), let desiredColor { calendar.cgColor = desiredColor }
            do {
                try eventStore.saveCalendar(calendar, commit: true)
                UserDefaults.standard.set(calendar.calendarIdentifier, forKey: ownedCalendarIdentifierKey)
                return calendar
            } catch {
                eventStore.reset()
            }
        }
        throw BridgeError("Apple Calendar found your Google account, but none of its sources allow a Lectio calendar to be created. In Apple Calendar, create a calendar named ‘Lectio’ under Google, then try again.")
    }

    private func apply(_ color: CGColor?, to calendar: EKCalendar) throws {
        guard let color else { return }
        if #available(macOS 10.15, *) {
            guard calendar.cgColor != color else { return }
            calendar.cgColor = color
            try eventStore.saveCalendar(calendar, commit: true)
        }
    }

    private func calendarColor(from hex: String) -> CGColor? {
        guard hex.range(of: #"^#[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil else {
            return nil
        }
        var value: UInt64 = 0
        guard Scanner(string: String(hex.dropFirst())).scanHexInt64(&value) else { return nil }
        return CGColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    private func preferredGoogleSourceIdentifiers() -> [String] {
        var identifiers: [String] = []
        if let defaultSource = eventStore.defaultCalendarForNewEvents?.source,
           isGoogleSource(defaultSource) {
            identifiers.append(defaultSource.sourceIdentifier)
        }
        for source in eventStore.sources where isGoogleSource(source) {
            if !identifiers.contains(source.sourceIdentifier) {
                identifiers.append(source.sourceIdentifier)
            }
        }
        return identifiers
    }

    private func ownedCalendar(withIdentifier identifier: String) -> EKCalendar? {
        guard UserDefaults.standard.string(forKey: ownedCalendarIdentifierKey) == identifier,
              let calendar = eventStore.calendar(withIdentifier: identifier),
              calendar.title == calendarName,
              isGoogleSource(calendar.source) else { return nil }
        return calendar
    }

    private func isGoogleSource(_ source: EKSource) -> Bool {
        guard source.sourceType == .calDAV else { return false }
        let label = "\(source.title) \(source.sourceIdentifier)".lowercased()
        return label.contains("google") || label.contains("gmail")
    }

    private func apply(operations: [[String: Any]], to calendar: EKCalendar) throws -> [String: Any] {
        guard operations.count <= maximumOperations else {
            throw BridgeError("Too many calendar changes were requested at once.")
        }

        var inserted = 0
        var updated = 0
        var deleted = 0
        var unchanged = 0

        do {
            for operation in operations {
                guard let kind = operation["kind"] as? String else {
                    throw BridgeError("A calendar change was missing its action.")
                }
                switch kind {
                case "noop":
                    unchanged += 1

                case "insert":
                    guard let input = operation["event"] as? [String: Any] else {
                        throw BridgeError("A new calendar event was invalid.")
                    }
                    let event = EKEvent(eventStore: eventStore)
                    try populate(event, from: input, calendar: calendar)
                    try eventStore.save(event, span: .thisEvent, commit: false)
                    inserted += 1

                case "update":
                    guard let input = operation["event"] as? [String: Any],
                          let eventId = operation["eventId"] as? String,
                          let sourceId = input["sourceId"] as? String,
                          eventId.count <= 512 else {
                        throw BridgeError("An updated calendar event was invalid.")
                    }
                    let existing = eventStore.event(withIdentifier: eventId)
                    let event: EKEvent
                    if let existing {
                        guard existing.calendar.calendarIdentifier == calendar.calendarIdentifier,
                              let marker = readMarker(from: existing.url),
                              marker.sourceId == sourceId else {
                            throw BridgeError("Lectio Sync refused to update an event it does not own.")
                        }
                        event = existing
                        updated += 1
                    } else {
                        event = EKEvent(eventStore: eventStore)
                        inserted += 1
                    }
                    try populate(event, from: input, calendar: calendar)
                    try eventStore.save(event, span: .thisEvent, commit: false)

                case "delete":
                    guard let eventId = operation["eventId"] as? String,
                          let sourceId = operation["sourceId"] as? String,
                          eventId.count <= 512 else {
                        throw BridgeError("A removed calendar event was invalid.")
                    }
                    guard let event = eventStore.event(withIdentifier: eventId) else {
                        unchanged += 1
                        continue
                    }
                    guard event.calendar.calendarIdentifier == calendar.calendarIdentifier,
                          let marker = readMarker(from: event.url),
                          marker.sourceId == sourceId else {
                        throw BridgeError("Lectio Sync refused to remove an event it does not own.")
                    }
                    try eventStore.remove(event, span: .thisEvent, commit: false)
                    deleted += 1

                default:
                    throw BridgeError("An unsupported calendar change was requested.")
                }
            }

            if inserted + updated + deleted > 0 {
                try eventStore.commit()
            }
        } catch {
            eventStore.reset()
            throw error
        }
        return [
            "inserted": inserted,
            "updated": updated,
            "deleted": deleted,
            "unchanged": unchanged,
            "fetched": operations.count,
            "completedAt": ISO8601DateFormatter().string(from: Date())
        ]
    }

    private func populate(_ event: EKEvent, from input: [String: Any], calendar: EKCalendar) throws {
        guard let summary = input["summary"] as? String,
              let description = input["description"] as? String,
              let startString = input["start"] as? String,
              let endString = input["end"] as? String,
              let start = parseLectioDate(startString),
              let end = parseLectioDate(endString),
              start < end,
              let sourceId = input["sourceId"] as? String,
              let fingerprint = input["fingerprint"] as? String,
              !summary.isEmpty,
              summary.count <= 300,
              description.count <= 5_000,
              sourceId.range(of: #"^[A-Za-z0-9_./?=&:%+-]{1,500}$"#, options: .regularExpression) != nil,
              fingerprint.range(of: #"^[0-9a-v]{16,64}$"#, options: .regularExpression) != nil,
              ((input["location"] as? String)?.count ?? 0) <= 300 else {
            throw BridgeError("A calendar event contained invalid fields.")
        }

        event.calendar = calendar
        event.title = summary
        event.notes = description
        event.location = input["location"] as? String
        event.startDate = start
        event.endDate = end
        event.timeZone = TimeZone(identifier: "Europe/Copenhagen")
        event.availability = (input["transparency"] as? String) == "transparent" ? .free : .busy
        event.url = markerURL(sourceId: sourceId, fingerprint: fingerprint)
    }

    private let fractionalInstantFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private let instantFormatter = ISO8601DateFormatter()
    private let lectioDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "Europe/Copenhagen")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        formatter.isLenient = false
        return formatter
    }()

    private func parseInstant(_ value: String) -> Date? {
        fractionalInstantFormatter.date(from: value) ?? instantFormatter.date(from: value)
    }

    private func parseLectioDate(_ value: String) -> Date? {
        // Schedule dates use exactly this local format. Avoid two failed ISO
        // parses for each start/end while retaining support for absolute dates.
        if value.utf8.count == 19 { return lectioDateFormatter.date(from: value) }
        return parseInstant(value) ?? lectioDateFormatter.date(from: value)
    }

    private func markerURL(sourceId: String, fingerprint: String) -> URL? {
        var components = URLComponents()
        components.scheme = markerScheme
        components.host = "event"
        components.queryItems = [
            URLQueryItem(name: "sourceId", value: sourceId),
            URLQueryItem(name: "fingerprint", value: fingerprint)
        ]
        return components.url
    }

    private func readMarker(from url: URL?) -> (sourceId: String, fingerprint: String?)? {
        guard let url,
              url.scheme == markerScheme,
              url.host == "event",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let sourceId = components.queryItems?.first(where: { $0.name == "sourceId" })?.value,
              !sourceId.isEmpty else { return nil }
        let fingerprint = components.queryItems?.first(where: { $0.name == "fingerprint" })?.value
        return (sourceId, fingerprint)
    }

    private func extensionMessage(from item: NSExtensionItem) -> Any? {
        if #available(iOS 15.0, macOS 11.0, *) {
            return item.userInfo?[SFExtensionMessageKey]
        }
        return item.userInfo?["message"]
    }

    private func complete(_ context: NSExtensionContext, data: Any) {
        finish(context, payload: ["ok": true, "data": data])
    }

    private func complete(_ context: NSExtensionContext, error: String) {
        finish(context, payload: ["ok": false, "error": error])
    }

    private func finish(_ context: NSExtensionContext, payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

private struct BridgeError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}
