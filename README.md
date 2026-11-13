# 运单工作台 · Package Tracking

面向企业内部的 Windows 快递单号查询工具。Tauri 2 + Rust + React + TypeScript；通过独立、可见的 Microsoft Edge / Chrome 窗口操作快递100网页，读取页面查询结果。

## 功能

- 批量粘贴单号，导入 UTF-8 TXT / CSV；保留前导零和长数字，自动去重，每次最多 1000 单。
- 逐单串行查询，显示完成数量、成功、失败、跳过和当前单号。
- 暂停、继续、停止；需要手机号后四位或网页验证时等待人工处理，可以跳过。
- 查看物流时间线、状态筛选、备注、搜索、批量选择及 CSV 导出。
- 自动复查跟踪中的未完成运单；已签收、已退回和待人工处理的运单不自动重试。
- 本地持久化，重启后保留记录；失败和取消不覆盖此前成功取得的物流轨迹。

界面预览使用合成样例数据：[总览](docs/overview.png)、[物流详情](docs/detail.png)。验证范围见 [VALIDATION.md](VALIDATION.md)。

## Windows 使用

支持 Windows 10 / 11 x64。需要 Microsoft Edge（或 Chrome）和 WebView2 Runtime。安装包在缺少 WebView2 时会尝试联网安装；便携包需要机器上已有该运行时，并将 WebView2Loader.dll 保留在 EXE 同目录。

1. 启动应用，点击“添加运单”，粘贴单号或选择 TXT / CSV 文件。
2. 选择默认快递公司，或保留“自动识别”，点击添加。
3. 点击“开始批量查询”；也可先勾选部分运单，只查询选中项。
4. 查询会打开运单工作台专用 Edge 窗口。遇到验证，在该窗口完成，再回主界面点击“继续查询”；不能完成时选择“跳过此单”。
5. 在“偏好设置”开启自动跟踪。默认每 60 分钟复查，每单之间等待 5 秒。

**自动跟踪仅在应用运行时执行。** 关闭主窗口会退出应用和专用查询浏览器；当前版本不提供后台系统服务或开机启动。

当前快递100网页对部分承运商仅展示小程序 / App 查询入口，例如部分中通、韵达、申通单号。工具会显示“需要处理”，不会假造轨迹或把“无结果”当作“已签收”。成功查询能力受网页当前支持范围、网络和验证流程影响。页面结构改变后可能需要更新适配器。

CSV 示例（测试单号，不对应真实包裹）：

    单号,快递公司,备注
    SF1000000000001,顺丰速运,客户 A
    JD1000000000002,jd,办公用品
    001234567890,,自动识别

支持“单号 / 快递公司 / 备注”三列；快递公司可填界面中的名称或编码。每行只填单号也可；Excel 导入长单号前应将该列设为文本，避免 Excel 预先截断数字。

## 开发与构建

Windows 开发机安装：

- Node.js 22 LTS 或更新版本。
- Rust stable，使用 x86_64-pc-windows-msvc 工具链。
- Visual Studio Build Tools 2022 的“使用 C++ 的桌面开发”和 Windows SDK。
- Microsoft Edge 与 WebView2 Runtime。

运行：

    npm ci
    npm run tauri dev

构建 Windows 安装包：

    npm run tauri build

输出：

- 独立程序：src-tauri/target/release/package-tracking.exe
- NSIS 安装包：src-tauri/target/release/bundle/nsis/*-setup.exe

仓库包含 .github/workflows/windows.yml，可在 Windows runner 上测试、检查并构建安装包，产物作为 workflow artifact 保存；不会自动发布 release。

仅预览界面：

    npm run dev

浏览器预览使用独立的浏览器本地存储，明确提示不执行真实查件。不会把预览数据导入桌面应用。

## 验证

    npm test
    npm run build
    cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
    npm run test:e2e

Playwright 默认使用 Linux 的 /usr/bin/chromium。Windows 下运行浏览器测试前，设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE 为 Edge 或 Chrome 可执行文件的完整路径。测试截图与示例数据仅由 tests/e2e 创建，首次正常启动的运单列表为空。

## 数据与实现

Windows 数据目录为 %LOCALAPPDATA%\com.parceldesk.app：

项目名为 package-tracking，中文名为“运单工作台”。应用标识及原有数据目录沿用首版，以保留已有运单和安装升级关系；浏览器预览也沿用原来的存储键。

- shipments.json：运单、轨迹、备注、偏好设置；以临时文件写入后替换。
- edge-profile：运单工作台专用浏览器配置。与用户日常 Edge 配置隔离。

数据为本机明文文件，应用不内置云同步。导出 CSV 使用系统保存文件对话框。查询失败会保留历史状态，并单独记录错误；“物流异常”只来自实际物流状态。

Rust 后端负责数据存储、串行队列、定时任务及浏览器控制；前端关闭或重载不会导致后台队列重复启动。浏览器调试端口只绑定本机，外部查询页不拥有 Tauri IPC 权限。退出应用时关闭专用浏览器。

主要代码：

- src/App.tsx：运单列表、进度、导入、设置和物流详情。
- src-tauri/src/engine.rs：批次状态机及自动跟踪调度。
- src-tauri/src/browser.rs：启动专用 Edge / Chrome，通过 CDP 操作查询页面。
- src-tauri/src/probe.js：识别页面成功结果、人工验证和网页不支持的查询。
- src-tauri/src/storage.rs：本地文件持久化。

当前版本不调用收费 API，也不内置验证码识别、反检测或访问限制规避。
