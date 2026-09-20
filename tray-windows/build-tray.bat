@echo off
chcp 65001 >nul
echo 正在编译生成 Windows 托盘管理单文件程序...
cd /d "%~dp0"
dotnet publish ProxySocks5Tray.csproj -c Release -r win-x64 --no-self-contained -p:PublishSingleFile=true -o ..
if exist "..\ProxySocks5Tray.pdb" del /f /q "..\ProxySocks5Tray.pdb"
echo 编译完成！已生成根目录下的 ProxySocks5Tray.exe
pause
