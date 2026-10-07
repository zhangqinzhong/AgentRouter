import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, writeFileSync, rmSync, realpathSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {launchMacOSApplication} from "@agentrouter/core/platform/macos-app-launcher.ts";

test("launcher rejects launch errors, malformed replies and helper PIDs", {skip:process.platform === "win32"}, async () => {
  const root=mkdtempSync(path.join(os.tmpdir(),"ar-launch-protocol-"));
  try {
    const helper=path.join(root,"helper");
    for(const body of [
      'printf \'{"version":1,"error":"native launch failed"}\'; exit 1',
      'printf invalid',
      `printf '{"version":1,"pid":%s,"bundlePath":"${realpathSync(root)}"}' "$$"`,
      'printf \'{"version":1,"pid":0,"bundlePath":"/"}\'',
      'printf \'{"version":2,"pid":123,"bundlePath":"/"}\''
    ]) {
      writeFileSync(helper,"#!/bin/sh\ncat >/dev/null\n"+body+"\n",{mode:0o700});
      await assert.rejects(launchMacOSApplication(root,[],{},helper));
    }
    await assert.rejects(launchMacOSApplication(root,[],{},path.join(root,"missing")),/ENOENT/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
