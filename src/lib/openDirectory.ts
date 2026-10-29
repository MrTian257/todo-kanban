import { invoke } from "@tauri-apps/api/core";

export function openDirectory(path: string): Promise<void> {
  return invoke("open_directory", { path });
}
