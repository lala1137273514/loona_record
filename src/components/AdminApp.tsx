"use client";

import { useState } from "react";

type Summary = {
  total: number;
  byLabel: {
    real_pos: number;
    real_neg: number;
  };
  byContributor: Array<{
    uid: string;
    username: string;
    count: number;
  }>;
};

type AdminStatus = {
  kind: "idle" | "loading" | "success" | "error";
  message: string;
};

export function AdminApp() {
  const [token, setToken] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [status, setStatus] = useState<AdminStatus>({
    kind: "idle",
    message: "输入 admin token 后读取数据",
  });

  async function loadSummary() {
    setStatus({ kind: "loading", message: "读取中" });
    try {
      const response = await fetch("/api/admin/summary", {
        headers: { "x-admin-token": token },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? "读取失败");
      }
      setSummary(body as Summary);
      setStatus({ kind: "success", message: "已更新统计" });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "读取失败",
      });
    }
  }

  async function exportZip() {
    setStatus({ kind: "loading", message: "导出中" });
    try {
      const response = await fetch("/api/admin/export", {
        headers: { "x-admin-token": token },
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? "导出失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "collected.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatus({ kind: "success", message: "已开始下载 collected.zip" });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "导出失败",
      });
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Loona Record</p>
          <h1>管理员导出</h1>
        </div>
        <div className={`status status-${status.kind}`}>{status.message}</div>
      </section>

      <section className="workspace admin-workspace">
        <div className="panel">
          <h2>访问令牌</h2>
          <label className="field">
            <span>Admin token</span>
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="ADMIN_EXPORT_TOKEN"
              type="password"
            />
          </label>
          <div className="admin-actions">
            <button type="button" disabled={!token || status.kind === "loading"} onClick={loadSummary}>
              刷新统计
            </button>
            <button type="button" disabled={!token || status.kind === "loading"} onClick={exportZip}>
              导出 collected.zip
            </button>
          </div>
        </div>

        <div className="panel">
          <h2>总览</h2>
          {summary ? (
            <>
              <div className="stats">
                <span>
                  <strong>{summary.total}</strong>
                  全部
                </span>
                <span>
                  <strong>{summary.byLabel.real_pos}</strong>
                  real_pos
                </span>
                <span>
                  <strong>{summary.byLabel.real_neg}</strong>
                  real_neg
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>用户名</th>
                      <th>UID</th>
                      <th>数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byContributor.map((item) => (
                      <tr key={item.uid}>
                        <td>{item.username}</td>
                        <td>
                          <code>{item.uid}</code>
                        </td>
                        <td>{item.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="empty-player">暂无统计</div>
          )}
        </div>
      </section>
    </main>
  );
}
