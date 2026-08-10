import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const output = resolve("Safari");
await mkdir(output, { recursive: true });
await rm(resolve(output, "Lectio Sync"), { recursive: true, force: true });

const result = spawnSync("xcrun", [
  "safari-web-extension-converter",
  resolve("dist/safari"),
  "--project-location", output,
  "--app-name", "Lectio Sync",
  "--bundle-identifier", "dk.lectiosync.extension",
  "--copy-resources",
  "--no-open",
  "--no-prompt",
  "--force"
], { stdio: "inherit" });

if (result.status !== 0) process.exit(result.status ?? 1);

const projectRoot = resolve(output, "Lectio Sync");
await copyFile(
  resolve("safari-native/SafariWebExtensionHandler.swift"),
  resolve(projectRoot, "Shared (Extension)/SafariWebExtensionHandler.swift")
);
await copyFile(
  resolve("safari-native/LectioSync.entitlements"),
  resolve(projectRoot, "macOS (Extension)/LectioSync.entitlements")
);
await copyFile(
  resolve("safari-native/LectioSync.entitlements"),
  resolve(projectRoot, "macOS (App)/LectioSync.entitlements")
);

const usageDescriptions = [
  ["NSCalendarsUsageDescription", "Lectio Sync needs calendar access to add and update your timetable."],
  ["NSCalendarsFullAccessUsageDescription", "Lectio Sync needs full calendar access to keep its dedicated Lectio calendar up to date."]
];
for (const platform of ["iOS", "macOS"]) {
  for (const target of ["App", "Extension"]) {
    const plist = resolve(projectRoot, `${platform} (${target})/Info.plist`);
    for (const [key, description] of usageDescriptions) {
      const update = spawnSync("/usr/libexec/PlistBuddy", [
        "-c", `Add :${key} string ${description}`,
        plist
      ], { stdio: "inherit" });
      if (update.status !== 0) process.exit(update.status ?? 1);
    }
  }
}

const projectFile = resolve(projectRoot, "Lectio Sync.xcodeproj/project.pbxproj");
let project = await readFile(projectFile, "utf8");
for (const target of ["App", "Extension"]) {
  const infoPlist = `\t\t\t\tINFOPLIST_FILE = "macOS (${target})/Info.plist";`;
  const signing = [
    `\t\t\t\tCODE_SIGN_ENTITLEMENTS = "macOS (${target})/LectioSync.entitlements";`,
    "\t\t\t\tENABLE_RESOURCE_ACCESS_CALENDARS = YES;",
    infoPlist
  ].join("\n");
  const matches = project.split(infoPlist).length - 1;
  if (matches !== 2) {
    throw new Error(`Expected two macOS ${target.toLowerCase()} build configurations, found ${matches}.`);
  }
  project = project.replaceAll(infoPlist, signing);
}
await writeFile(projectFile, project);
