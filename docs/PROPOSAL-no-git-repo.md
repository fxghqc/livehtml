# PROPOSAL: livehtml 不是 git 仓库

## 现状

- `cd /Users/fx/Projects/livehtml && git status` → `fatal: not a git repository`
- 仓库根没有 `.git/`，但有完整 `.gitignore`（含 `state/*.json`、`.env`、`node_modules`）
- 父目录 `/Users/fx/Projects/` 也无 git 跟踪

## 问题

`/goal` 护栏里两条假设全部失效：

1. **"有问题可以直接 git 回退"** —— 没有 commit 历史可回退，改坏 `server.ts` 只能靠手工恢复
2. **"留分支等用户 review"** —— 无法形成 diff / branch，用户 review 只能逐个文件看

且 plan 隐含的"PR checklist"语义在没有 git 的情况下也失真 —— 不会真的有 PR。

## 备选方案

### 方案 A：现在 `git init` + 提一次 baseline commit

```bash
cd /Users/fx/Projects/livehtml
git init
git add -A   # 受 .gitignore 保护
git commit -m "baseline: pre-readback A+B+C"
git checkout -b readback-abc
```

- 优点：护栏立刻生效；后续可 `git diff readback-abc..main` 让用户 review
- 缺点：第一次 commit 会把当前 `bun.lock`、`node_modules` 状态、`Dockerfile` 等全部锁定，没有"干净的历史起点"。但这是 baseline，可接受
- 风险：`.env` 包含敏感信息（MinIO 密钥），`.gitignore` 已忽略，安全
- 工作量：30 秒

### 方案 B：用 `git init` 但延后 commit，先开个 stash 兜底

- `git init` 后只用 `git stash` / `git stash pop` 做局部快照
- 不提 baseline commit，避免"历史起点不干净"
- 缺点：stash 容易丢，不如 commit 稳

### 方案 C：放弃 git 护栏，改用 `cp -r` 备份目录

- 每个 phase 开始前 `cp -r livehtml livehtml.bak.<phase>`
- 缺点：占空间、无 diff、用户 review 体验差

### 方案 D：用户来 `git init` 并起一个新 branch，我等他做完

- 把决定权完全交回去
- 适用：用户对仓库布局有自己的偏好

## 推荐

**方案 A**。理由：

- 最小工作量
- 立刻让"回退"和"留 branch review"两条护栏物理上可行
- baseline commit 锁定的是真实当前状态，本来就是恢复目标
- `.gitignore` 已合理，`.env` 不会泄

唯一需要用户拍板的：是否同意我执行
```bash
git init
git add -A
git commit -m "baseline: pre-readback A+B+C readiness"
git checkout -b readback-abc
```

如果同意我会立刻做这一步然后继续 A，不用再次打断。

## 不做哪些

- **不**做 `git push` —— 没有远端，也不会自己 add 远端
- **不**预设 git remote / 不动 git config
- **不**改 `.gitignore`
