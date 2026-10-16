# Google Drive 跨端同步

Paper Reader 在每台设备保留本地文库，运行时通过 Google Drive 的应用专用空间双向同步。适用于当前 Windows、macOS 桌面版，以及在本机运行 Node 服务的浏览器版。浏览器版的 Google 登录必须在运行服务的同一台电脑上完成。

## 首次配置

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建或选择一个项目，启用 **Google Drive API**。
2. 在 **Google Auth Platform** 配置应用名称、用户支持邮箱和受众。个人使用可以选择 External / Testing，并把要登录的 Google 账号添加为测试用户。
3. 在 Data Access 添加 `https://www.googleapis.com/auth/drive.appdata`。应用仅请求此权限，不访问普通 Drive 文件，也不需要另外申请 `drive` 全盘权限。参见 [Google 应用数据文档](https://developers.google.com/workspace/drive/api/guides/appdata)。
4. 创建类型为 **Desktop app（桌面应用）** 的 OAuth Client，下载 JSON。不要使用 Web application 客户端，不需要手动登记固定回调端口。
5. 启动新版 Paper Reader，进入 **设置 → 跨端同步 · Google Drive → Google OAuth 配置**。填入 JSON 中 `installed.client_id` 和 `installed.client_secret`，保存配置，再点 **连接 Google Drive**。
6. 在系统浏览器完成授权，然后回到应用。启用自动同步时会开始首次同步；也可以点击 **立即同步**。
7. 在其他设备使用**同一组 Client ID / client_secret 和同一个 Google 账号**连接。已有文库会合并；新设备会下载云端文库。首次设备请等「同步完成」后再连接下一台。

桌面版通过系统浏览器授权，使用随机本地回调端口、PKCE 和一次性 state；不在 Electron 内嵌页面登录。参见 [Google 桌面应用 OAuth 流程](https://developers.google.com/identity/protocols/oauth2/native-app)。

Testing 状态的外部应用使用 Drive 权限时，刷新令牌通常 7 天后过期；届时断开并重新连接。长期使用或向其他用户发布前，应在 Google Cloud 完成相应的正式发布配置。参见 [Google 令牌有效期说明](https://developers.google.com/identity/protocols/oauth2#expiration)。

也可以在启动应用的环境中提供 `PAPER_GOOGLE_CLIENT_ID` 和 `PAPER_GOOGLE_CLIENT_SECRET` 作为默认凭据。环境变量不会自动写入安装包。OAuth 客户端凭据需由项目维护者在 Google Cloud 创建，本仓库不包含预设客户端。

## 同步内容与使用方式

| 内容 | 行为 |
| --- | --- |
| PDF、抽取的正文 | 按 SHA-256 内容去重传输，下载校验后写入 |
| 文献、网页正文、引用、标签、星标、回收站标记、阅读页码 | 按字段合并 |
| 高亮、批注、AI 回复与指令 | 按字段合并；正在执行的 AI / 索引任务状态留在本机 |
| 笔记、论文关联标记、笔记附件和空文件夹 | 保留相对目录结构 |
| API Key、模型设置、OAuth 令牌、绝对路径、界面偏好 | 不同步 |
| `.obsidian`、`.git`、`.trash` 等隐藏目录和符号链接 | 不同步 |

自动同步在本地更改后约 4 秒触发，并每分钟检查一次云端。启动时检查，网络错误后保留本地数据，下次周期继续尝试。应用关闭时不会同步。手动同步与自动同步共用一个任务，不会同时写入两次。

同步不会把正在使用的 SQLite 数据库文件直接上传或替换。每台设备写自己的云端清单，其他设备合并这些清单；附件准备好之后才发布引用它们的清单。离线更改、硬删除记录和笔记删除均保留版本信息，避免旧设备把已删除内容重新带回。

不同字段上的离线编辑会分别保留。同一个字段并发编辑时，按逻辑版本号和设备标识确定一致的结果，不依赖设备系统时间。笔记或附件出现不同并发内容时，另存 `文件名 (冲突-设备-版本).md` 一类副本；可在应用中检查和整理。编辑器尚未保存的本地草稿也会保留；保存时若文件已被其他设备更新，会先为原内容创建冲突副本。

同步文件名遵循 Windows / macOS 通用规则。大小写不同但实际会重名的文件、保留名称或符号链接会使同步停止并给出错误，请在原设备重命名后重试。

## 本地状态与恢复

数据目录的 `sync/` 保存本机同步状态和缓存：

```text
sync/
  config.json          OAuth 客户端配置、自动同步开关
  credentials.json     本机 Google 刷新令牌
  state.json           设备标识、版本信息、上次本地快照
  blobs/               按内容哈希存放的附件缓存
  backups/<时间>/      合并前被替换或删除的文件，以及 values.json 数据字段快照
```

Windows / macOS 桌面端通过 Electron `safeStorage` 加密 OAuth 刷新令牌和 client_secret；命令行模式使用当前用户可读写的本地文件（创建权限 `0600`，Windows 的实际访问控制还取决于目录 ACL）。这些文件不会上传至 Drive，也不要把 `sync/` 复制给其他设备，否则会复制同一设备标识。其他设备应独立安装并登录。

断开连接只清除本机 Google 登录信息，保留文库、客户端配置、同步历史和云端数据。换 Google 账号 / Client ID 时，会为新的同步空间重建本机索引并保留旧索引备份，避免传播旧账号的删除记录。

连接期间更改笔记库绝对路径会暂停同步，以免将原笔记误认为已删除。切回原路径，或在确认新笔记库后断开并重新连接，即可重新合并云端内容。

云端旧附件和本地备份目前保留，不自动回收。因此大量修改 PDF / 笔记附件后会增加磁盘和 Drive 占用。备份中的 `values.json` 可用于检查原文献、批注字段，文件可手动复制回文库。没有一键恢复工具；在恢复前先断开同步并备份整个数据目录。不要在仍有其他设备离线时直接清空版本历史。

常见错误：

- `403`：检查是否已启用 Google Drive API、是否有组织策略限制，以及 Drive 剩余空间。
- 授权失效：断开后重新连接；测试应用还需检查测试用户及令牌有效期。
- 无法访问 Google：确保运行 Paper Reader 服务的电脑能访问 Google 登录、`oauth2.googleapis.com` 和 `www.googleapis.com`。
- PDF 文件缺失：先在原设备恢复对应 PDF；同步会停下，防止将附件缺失传播给其他设备。
- 初始化状态损坏：应用仍可离线使用。先备份整个 `sync/` 再检查状态文件；不要直接删除同步索引来强制覆盖云端。

## 开发验证

```bash
npm run test:sync
npm run build
```

测试使用独立临时文库和模拟 Drive，覆盖多设备合并、文件去重、笔记冲突、删除、重试、同步期间编辑、PKCE/state、令牌刷新、分页、分块上传及本地 HTTP 接口。真正的 Google 账号授权、配额和跨网络传输仍需使用实际 OAuth 客户端进行联调。
