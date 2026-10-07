import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const current = await readFile('safari-native/SafariWebExtensionHandler.swift', 'utf8');
const baseline = process.argv[2] ? await readFile(process.argv[2], 'utf8') : undefined;
function methods(source) {
  const start = source.includes('private let fractionalInstantFormatter')
    ? source.indexOf('    private let fractionalInstantFormatter')
    : source.indexOf('    private func parseInstant');
  return source.slice(start, source.indexOf('    private func markerURL', start)).replaceAll('private ', '');
}
const code = `import Foundation
class Current { ${methods(current)} }
${baseline ? `class Baseline { ${methods(baseline)} }` : ''}
let cases = ["2026-10-02T12:00:00", "2026-10-02T12:00:00Z", "2026-10-02T12:00:00.123Z", "2026-10-02T12:00:00+02:00", "2026-03-29T02:30:00", "2026-10-25T02:30:00", "2026-02-30T12:00:00", "invalid"]
let current = Current()
${baseline ? 'let baseline = Baseline()\nfor value in cases { precondition(current.parseLectioDate(value) == baseline.parseLectioDate(value), value) }' : ''}
func measure(_ work: () -> Void) -> Double {
    var samples: [Double] = []
    for _ in 0..<7 {
        let start = DispatchTime.now().uptimeNanoseconds
        work()
        samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
    }
    return samples.sorted()[3]
}
let after = measure {
    let parser = Current()
    for _ in 0..<1_000 { precondition(parser.parseLectioDate("2026-10-02T12:00:00") != nil) }
}
${baseline ? 'let before = measure {\n    let parser = Baseline()\n    for _ in 0..<1_000 { precondition(parser.parseLectioDate("2026-10-02T12:00:00") != nil) }\n}\nprint("{\\\"currentMs\\\": \\(after), \\\"baselineMs\\\": \\(before), \\\"reductionPercent\\\": \\((1 - after / before) * 100)}")' : 'print("{\\\"currentMs\\\": \\(after)}")'}
`;
await mkdir('.build', { recursive: true });
await writeFile('.build/performance-safari-dates.swift', code);
const compile = spawnSync('xcrun', ['swiftc', '-O', '.build/performance-safari-dates.swift', '-o', '.build/performance-safari-dates'], { encoding: 'utf8' });
if (compile.status !== 0) throw new Error(compile.stderr);
const run = spawnSync(resolve('.build/performance-safari-dates'), [], { encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr);
console.log(run.stdout.trim());
await writeFile('.build/performance-safari-date-results.json', run.stdout);
