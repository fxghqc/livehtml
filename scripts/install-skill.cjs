#!/usr/bin/env node
// livehtml-skill: install the livehtml skill into a Claude Code skills dir.
//
//   livehtml-skill install              # copy to ~/.claude/skills/livehtml
//   livehtml-skill install --link       # symlink instead (dev mode; needs local skill/ dir)
//   livehtml-skill install --dest <dir> # custom target
//   livehtml-skill uninstall
//   livehtml-skill status
//
// Works in three install contexts:
//   1. Local repo:  node scripts/install-skill.js install [--link]
//   2. npx (git):   npx -y github:<user>/<repo> install
//   3. npx (npm):   npx livehtml-skill install
//   4. curl shim:   curl http://<host>/install | sh

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOME = os.homedir();
const DEFAULT_DEST = path.join(HOME, ".claude", "skills", "livehtml");
const SKILL_NAME = "livehtml";

// Locate the skill source. Either:
//  - sibling 'skill/' dir (when running from repo root)
//  - parent of this script when packaged as npm package's bin (../skill)
function findSkillSource() {
  const candidates = [
    path.resolve(__dirname, "..", "skill"),       // repo: scripts/ → ../skill
    path.resolve(__dirname, "skill"),             // flat layout
    path.resolve(process.cwd(), "skill"),         // cwd
    path.resolve(process.cwd(), "..", "skill"),   // parent of cwd
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "SKILL.md"))) return c;
  }
  return null;
}

function parseArgs(argv) {
  const args = { _: [], link: false, dest: DEFAULT_DEST, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--link") args.link = true;
    else if (a === "--force" || a === "-f") args.force = true;
    else if (a === "--dest") args.dest = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function help() {
  console.log(`livehtml-skill — install the livehtml skill for Claude Code

Commands:
  install              Install (copy) the skill to ~/.claude/skills/livehtml
  install --link       Symlink instead of copy (dev mode; needs a local skill/ dir)
  install --dest DIR   Install to a custom directory
  install --force      Overwrite existing installation without prompting
  uninstall            Remove the installed skill
  status               Show install state

The skill is the user-facing contract for the livehtml service (the server
that hosts agent-generated HTML and provides multi-user state sync).
`);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function rmrf(p) {
  if (!fs.existsSync(p) && !fs.lstatSync(p, { throwIfNoEntry: false })) return;
  // Use fs.rmSync which handles symlinks and dirs
  fs.rmSync(p, { recursive: true, force: true });
}

function describe(p) {
  try {
    const lst = fs.lstatSync(p);
    if (lst.isSymbolicLink()) return `symlink → ${fs.readlinkSync(p)}`;
    if (lst.isDirectory()) return `directory (${fs.readdirSync(p).length} entries)`;
    return "file";
  } catch {
    return null;
  }
}

function cmdStatus(args) {
  const existing = describe(args.dest);
  if (!existing) {
    console.log(`Not installed at ${args.dest}`);
    process.exit(1);
  }
  console.log(`Installed at ${args.dest}`);
  console.log(`  ${existing}`);
  const skillMd = path.join(args.dest, "SKILL.md");
  if (fs.existsSync(skillMd)) {
    const head = fs.readFileSync(skillMd, "utf8").split("\n").slice(0, 4).join("\n");
    console.log(`\nSKILL.md head:\n${head}`);
  }
}

function cmdInstall(args) {
  const src = findSkillSource();
  if (!src) {
    console.error("Could not find skill source (looked for sibling 'skill/' dir with SKILL.md).");
    console.error("Run from the livehtml repo, or use --dest pointing at an unpacked skill dir.");
    process.exit(2);
  }
  console.log(`Source:  ${src}`);
  console.log(`Target:  ${args.dest}`);
  console.log(`Mode:    ${args.link ? "symlink" : "copy"}`);

  const existing = describe(args.dest);
  if (existing && !args.force) {
    if (process.stdin.isTTY) {
      // simple prompt
      const ans = require("node:readline")
        .createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        ans.question(`Already exists (${existing}). Overwrite? [y/N] `, (a) => {
          ans.close();
          if (a.trim().toLowerCase() !== "y") {
            console.log("Aborted. Re-run with --force to skip this prompt.");
            process.exit(0);
          }
          doInstall(src, args);
          resolve();
        });
      });
    }
    console.error(`Refusing to overwrite (${existing}). Re-run with --force.`);
    process.exit(3);
  }
  doInstall(src, args);
}

function doInstall(src, args) {
  rmrf(args.dest);
  fs.mkdirSync(path.dirname(args.dest), { recursive: true });
  if (args.link) {
    fs.symlinkSync(src, args.dest, "dir");
    console.log(`✓ Symlinked → ${src}`);
  } else {
    copyDir(src, args.dest);
    console.log(`✓ Copied to ${args.dest}`);
  }
  console.log(`\nSkill installed. Restart or reload Claude Code to pick it up.`);
  console.log(`Check with: livehtml-skill status`);
}

function cmdUninstall(args) {
  const existing = describe(args.dest);
  if (!existing) {
    console.log(`Nothing to uninstall at ${args.dest}`);
    return;
  }
  rmrf(args.dest);
  console.log(`✓ Removed ${args.dest} (was ${existing})`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) return help();
  const sub = args._[0];
  if (sub === "install") return cmdInstall(args);
  if (sub === "uninstall") return cmdUninstall(args);
  if (sub === "status") return cmdStatus(args);
  console.error(`Unknown command: ${sub}\n`);
  help();
  process.exit(1);
}

main();
