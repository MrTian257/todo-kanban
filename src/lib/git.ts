// git 封装：9 个 invoke + 3 个缓存函数（60s TTL + 单飞去重 + 路径大小写折叠 + 同步 peek）
// 浏览器模式（非 Tauri）下函数直接抛错/返回空，由调用方处理。

import { invoke } from "@tauri-apps/api/core";
import { CommitInfo, GitInfo } from "./types";
import { isTauri } from "./storage";

// ── invoke 封装 ─────────────────────────────────────────
export async function gitInfo(repo: string): Promise<GitInfo> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  return invoke<GitInfo>("git_info", { repo });
}

export async function gitInfoRefresh(repo: string): Promise<GitInfo> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  return invoke<GitInfo>("git_info_refresh", { repo });
}

export async function gitInfoRemote(repo: string, repoUrl: string, token: string): Promise<GitInfo> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  return invoke<GitInfo>("git_info_remote", { repo, repoUrl, token });
}

export async function gitCreateBranch(repo: string, branch: string): Promise<void> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  await invoke("git_create_branch", { repo, branch });
}

export async function gitCreateBranchFrom(repo: string, branch: string, from: string): Promise<void> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  await invoke("git_create_branch_from", { repo, branch, from });
}

export async function gitCheckoutBranch(repo: string, branch: string): Promise<void> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  await invoke("git_checkout_branch", { repo, branch });
}

export async function gitSyncCommits(repo: string, tag: string): Promise<CommitInfo[]> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  return invoke<CommitInfo[]>("git_sync_commits", { repo, tag });
}

export async function gitCommitsBetween(repo: string, branch: string, since: string, until: string): Promise<CommitInfo[]> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  return invoke<CommitInfo[]>("git_commits_between", { repo, branch, since, until });
}

export async function gitCommitInfo(repo: string, hash: string): Promise<CommitInfo> {
  if (!isTauri()) throw new Error("非桌面环境，git 能力不可用");
  return invoke<CommitInfo>("git_commit_info", { repo, hash });
}

// ── 前端缓存（60s TTL + 单飞去重 + 路径大小写折叠） ─────────────
const CACHE_TTL = 60_000;
const cache = new Map<string, { at: number; info: GitInfo }>();
const inflight = new Map<string, Promise<GitInfo>>();

function keyOf(repo: string): string {
  return repo.trim().toLowerCase().replace(/[\\/]+$/, "");
}

/** 同步 peek：缓存命中立即返回，否则 null */
export function peekGitInfo(repo: string): GitInfo | null {
  const k = keyOf(repo);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.info;
  return null;
}

/** 缓存优先拉取：命中即回；未命中单飞去重 */
export async function gitInfoCached(repo: string): Promise<GitInfo> {
  const k = keyOf(repo);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.info;
  const inflightHit = inflight.get(k);
  if (inflightHit) return inflightHit;
  const p = gitInfoRefresh(repo)
    .then((info) => {
      cache.set(k, { at: Date.now(), info });
      return info;
    })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/** 分支写操作成功后失效（前端缓存 + 后端缓存由命令侧失效） */
export function invalidateGitInfo(repo: string) {
  cache.delete(keyOf(repo));
}