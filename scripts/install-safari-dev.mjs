import { access, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const appBundleId = "dk.lectiosync.extension";
const extensionBundleId = "dk.lectiosync.extension.Extension";
const project = resolve("Safari/Lectio Sync/Lectio Sync.xcodeproj");
const destination = join(homedir(), "Applications", "Lectio Sync Dev.app");
const destinationExtension = join(
  destination,
  "Contents/PlugIns/Lectio Sync Extension.appex"
);
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed${detail ? `:\n${detail}` : "."}`);
  }
  return result;
}

function signingTeamForApp(app) {
  const result = run("codesign", ["-dv", "--verbose=2", app], {
    capture: true,
    allowFailure: true
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1];
}

function registeredExtensionApps() {
  const result = run("pluginkit", ["-m", "-A", "-D", "-v", "-i", extensionBundleId], {
    capture: true,
    allowFailure: true
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .map((line) => line.match(/\t(\/.*\/Contents\/PlugIns\/[^/]+\.appex)$/)?.[1])
    .filter(Boolean)
    .map((extension) => extension.split("/Contents/PlugIns/")[0]);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function detectSigningTeam() {
  if (process.env.SAFARI_DEVELOPMENT_TEAM) {
    return process.env.SAFARI_DEVELOPMENT_TEAM;
  }
  for (const app of [destination, ...registeredExtensionApps()]) {
    const team = signingTeamForApp(app);
    if (team) return team;
  }
  throw new Error(
    "Could not detect an Apple development team. Set SAFARI_DEVELOPMENT_TEAM once, then rerun."
  );
}

function registeredLectioPaths() {
  const dump = run(lsregister, ["-dump"], {
    capture: true,
    allowFailure: true
  }).stdout ?? "";
  return dump
    .split("--------------------------------------------------------------------------------")
    .filter((record) =>
      new RegExp(`^identifier:\\s+(?:${appBundleId}|${extensionBundleId})$`, "m").test(record)
    )
    .map((record) => record.match(/^path:\s+(.+?)(?:\s+\(0x[0-9a-f]+\))?$/m)?.[1])
    .filter(Boolean);
}

await mkdir(join(homedir(), "Applications"), { recursive: true });
const team = detectSigningTeam();
const destinationWasRegistered = registeredExtensionApps().includes(destination);
const derivedData = join(homedir(), "Library/Caches/LectioSyncDevDerivedData");
const staging = join(homedir(), "Applications", ".Lectio Sync Dev.app.staging");

try {
  console.log("Rebuilding the Safari extension and generated Xcode project…");
  run("npm", ["run", "convert:safari"]);
  console.log("Building and signing the macOS host app…");
  run("xcodebuild", [
    "-quiet",
    "-project", project,
    "-scheme", "Lectio Sync (macOS)",
    "-configuration", "Debug",
    "-derivedDataPath", derivedData,
    `DEVELOPMENT_TEAM=${team}`,
    "CODE_SIGN_STYLE=Automatic",
    "build"
  ]);

  const builtApp = join(derivedData, "Build/Products/Debug/Lectio Sync.app");
  run("codesign", ["--verify", "--deep", "--strict", builtApp]);

  console.log("Installing the verified app and cleaning stale registrations…");
  await rm(staging, { recursive: true, force: true });
  run("ditto", ["--noextattr", "--norsrc", builtApp, staging]);
  run("xattr", ["-cr", staging]);
  run("codesign", ["--verify", "--deep", "--strict", staging]);

  for (const path of registeredLectioPaths()) {
    if (path !== destination && !path.startsWith(`${destination}/`)) {
      run(lsregister, ["-u", path], { capture: true, allowFailure: true });
    }
  }
  for (const app of registeredExtensionApps()) {
    const extension = join(app, "Contents/PlugIns/Lectio Sync Extension.appex");
    if (extension !== destinationExtension) {
      run("pluginkit", ["-r", extension], { capture: true, allowFailure: true });
    }
  }

  run("pkill", ["-f", `^${destination}/Contents/MacOS/Lectio Sync$`], {
    capture: true,
    allowFailure: true
  });
  run("sleep", ["1"]);
  if (await exists(destination)) {
    run("rsync", ["-a", "--delete", `${staging}/`, `${destination}/`]);
    await rm(staging, { recursive: true, force: true });
  } else {
    await rename(staging, destination);
  }
  run("xattr", ["-cr", destination]);
  run("codesign", ["--verify", "--deep", "--strict", destination]);
  if (!destinationWasRegistered) {
    run(lsregister, ["-f", destination], { capture: true });
    run("pluginkit", ["-a", destinationExtension]);
  }
  run("open", [destination]);

  const installedTeam = signingTeamForApp(destination);
  if (installedTeam !== team) {
    throw new Error("Installed Safari app signature did not match the selected team.");
  }
  console.log(`Safari development build installed and launched: ${destination}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
