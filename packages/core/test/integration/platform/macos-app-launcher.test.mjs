import assert from "node:assert/strict";
import test from "node:test";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {launchMacOSApplication} from "@agentrouter/core/platform/macos-app-launcher.ts";

test("LaunchServices preserves arguments/env, creates distinct instances and tracks real app PIDs", {skip:process.platform !== "darwin"}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-launch-test-"));
  const bundle = path.join(root, "Fixture.app");
  const contents = path.join(bundle, "Contents");
  const pids = [];
  try {
    mkdirSync(path.join(contents, "MacOS"), {recursive:true});
    writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.agentrouter.launch-test</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
    const source = path.join(root,"main.swift");
    writeFileSync(source, `import AppKit
let app = NSApplication.shared
let env = ProcessInfo.processInfo.environment
let data = try! JSONSerialization.data(withJSONObject: ["pid":Int(getpid()), "args":CommandLine.arguments, "value":env["AR_TEST_VALUE"] ?? "", "home":env["CODEX_HOME"] ?? ""])
try! data.write(to: URL(fileURLWithPath:env["AR_TEST_OUTPUT"]!))
DispatchQueue.main.asyncAfter(deadline:.now()+30) { exit(0) }
app.run()
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", source, "-o", path.join(contents,"MacOS/Fixture")]);
    execFileSync("/usr/bin/codesign", ["--force","--sign","-",bundle]);
    const helper = path.resolve("packages/core/dist/main/app-launcher/AgentRouterAppLauncher");
    for (const id of ["one","two"]) {
      const output = path.join(root,id+".json");
      const args = ["--user-data-dir="+path.join(root,id), "--remote-debugging-port=0", "space and 中文"];
      const pid = await launchMacOSApplication(bundle,args,{...process.env, AR_TEST_OUTPUT:output, AR_TEST_VALUE:"secret-like value 中文",CODEX_HOME:path.join(root,id)},helper);
      pids.push(pid);
      let data;
      for(let n=0;n<100;n++) {
        try {data=JSON.parse(readFileSync(output,"utf8"));break;}catch{}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.equal(data.pid,pid);
      assert.deepEqual(data.args.slice(1),args);
      assert.equal(data.value,"secret-like value 中文");
      assert.equal(data.home,path.join(root,id));
      process.kill(pid,0);
    }
    assert.notEqual(pids[0],pids[1]);
    process.kill(pids[0],"SIGTERM");
    await new Promise(resolve=>setTimeout(resolve,300));
    process.kill(pids[1],0);
    await assert.rejects(launchMacOSApplication(root,[],{},helper), /application bundle path/);
  } finally {
    for(const pid of pids) {try{process.kill(pid,"SIGTERM");}catch{}}
    rmSync(root,{recursive:true,force:true});
  }
});
