import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/storage";
import { isMacOS } from "@/lib/platform";

/** 原生选择返回真实绝对路径；取消不改写字段，仍允许手动输入。 */
export function DirectoryInput({ id, value, onChange, autoFocus = false }: {
  id: string; value: string; onChange: (value: string) => void; autoFocus?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const choosing = useRef(false);
  const choose = async () => {
    if (choosing.current) return;
    choosing.current = true;
    setBusy(true);
    try {
      const path = await open({ directory: true, multiple: false, title: "选择代码目录" });
      if (typeof path === "string") onChange(path);
    } catch (error) { toast.error(`无法选择目录：${String(error)}`); }
    finally { choosing.current = false; setBusy(false); }
  };
  return <div className="space-y-2">
    <Input id={id} value={value} onChange={event => onChange(event.target.value)} autoFocus={autoFocus}
      placeholder={isMacOS ? "/Users/你的用户名/Projects/project" : "代码仓库绝对路径"} />
    {isTauri() && <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void choose()}>选择文件夹…</Button>
      {value && <Button type="button" size="sm" variant="ghost" onClick={() => void openPath(value).catch(error => toast.error(`无法打开目录：${String(error)}`))}>{isMacOS ? "在 Finder 中打开" : "打开目录"}</Button>}
    </div>}
  </div>;
}
