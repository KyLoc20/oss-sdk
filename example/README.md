# @kyloc20/oss-sdk example（仅开发）

Express 演示页，**不参与 npm 打包发布**。

| 路径 | 说明 |
|------|------|
| `/` | 入口 |
| `/example/local-fs` | localFs |
| `/example/r2` | r2 |

## 安全默认

- 只监听 **`127.0.0.1`**（可用 `EXAMPLE_HOST` 覆盖，不推荐）
- `.env` 含 R2 密钥时，必须设置 **`EXAMPLE_ALLOW_R2=1`** 才能启动
- `useEnvCredentials` 必须**显式**勾选；勾选后 endpoint/密钥**固定读 .env**（忽略请求里的 endpoint）
- 上传文件名只取 `basename`；下载临时文件响应结束后删除

## 启动

```bash
pnpm install
pnpm build
# 若要用 .env 里的 R2：
# EXAMPLE_ALLOW_R2=1 pnpm example
pnpm example
```

- http://127.0.0.1:3789/example/local-fs
- http://127.0.0.1:3789/example/r2

## r2 凭据

复制根目录 `.env.example` → `.env` 后填写（勿提交）。页面只显示脱敏值。
