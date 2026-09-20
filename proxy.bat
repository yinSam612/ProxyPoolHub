@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
goto :main

:main
set "ACTION=%~1"
if "%ACTION%"=="" (
    if exist "ProxySocks5Tray.exe" (
        goto :tray
    ) else (
        goto :web
    )
)

if /I "%ACTION%"=="help" goto :usage
if /I "%ACTION%"=="tray" goto :tray
if /I "%ACTION%"=="web" goto :web
if /I "%ACTION%"=="start" goto :web
if /I "%ACTION%"=="stop" goto :stop
if /I "%ACTION%"=="install" goto :install
if /I "%ACTION%"=="status" goto :status
goto :usage

:ensure_node
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未在系统 PATH 中检测到 Node.js。
  echo 请先下载安装 Node.js LTS (18+): https://nodejs.org/
  pause
  exit /b 1
)
exit /b 0

:ensure_npm
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 npm 命令，请重新安装 Node.js。
  pause
  exit /b 1
)
exit /b 0

:ensure_project
if not exist "server.js" (
  echo [错误] 未找到 server.js 文件。
  exit /b 1
)
if not exist "data" mkdir "data"
if not exist "runtime" mkdir "runtime"

if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo [提示] 已自动创建默认 .env 配置文件。
  )
)

if not exist "data\proxies.json" (
  if exist "data\proxies.json.example" (
    copy "data\proxies.json.example" "data\proxies.json" >nul
    echo [提示] 已自动初始化节点文件 data\proxies.json。
  )
)
exit /b 0

:ensure_dependencies
call :ensure_node || exit /b 1
call :ensure_npm || exit /b 1
call :ensure_project || exit /b 1

if not exist "node_modules" (
  echo [提示] 正在自动安装项目依赖...
  call npm.cmd install --omit=dev
  if errorlevel 1 (
    echo [错误] npm install 依赖安装失败。
    exit /b 1
  )
)
exit /b 0

:tray
call :ensure_dependencies || exit /b 1
if exist "ProxySocks5Tray.exe" (
  echo [提示] 正在启动 Proxy-SOCKS5 桌面托盘管理助手（后台静默模式）...
  start "" "ProxySocks5Tray.exe"
  echo [成功] 托盘程序已启动！请查看屏幕右下角通知区域。
  exit /b 0
) else (
  echo [提示] 未找到预编译的 ProxySocks5Tray.exe，正在切换为 Web 控制台前台模式...
  goto :web
)

:web
call :ensure_dependencies || exit /b 1
echo [提示] 正在启动 Proxy-SOCKS5 Web 服务 (前台模式，按 Ctrl+C 可停止)...
echo 访问管理面板: http://127.0.0.1:3100
node server.js
exit /b %ERRORLEVEL%

:stop
echo 正在停止 Proxy-SOCKS5 相关后台服务...
taskkill /F /IM ProxySocks5Tray.exe >nul 2>nul
taskkill /F /IM sing-box.exe >nul 2>nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3100" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>nul
)
echo [成功] 服务已停止。
exit /b 0

:install
call :ensure_dependencies || exit /b 1
echo [成功] 运行环境与依赖已就绪。
exit /b 0

:status
tasklist | findstr /I "node.exe ProxySocks5Tray.exe sing-box.exe"
netstat -ano | findstr ":3100 :40000"
exit /b 0

:usage
echo 使用说明:
echo   proxy.bat tray     ^| 启动 Windows 桌面托盘助手 (静默无黑框，常驻系统托盘)
echo   proxy.bat web      ^| 在当前 CMD 窗口前台运行 Web 服务与查看日志
echo   proxy.bat stop     ^| 一键停止后台服务与托盘程序
echo   proxy.bat install  ^| 初始化安装 Node.js 依赖
echo   proxy.bat status   ^| 查看当前运行状态与监听端口
exit /b 1
