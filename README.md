# HOMG0 局域网联机 Demo

## Windows 启动

1. 解压整个 `homg0_lan` 文件夹，不要只运行 bat 文件。
2. 安装 Node.js 18 或更新版本，并确保安装了 npm。
3. 双击 `start.bat`。
4. 程序会打开一个标题为 `HOMG0 LAN Server` 的黑色窗口，并保持窗口不关闭。
5. 第一次启动若没有 `node_modules/ws`，脚本会自动执行 `npm install`。

房主电脑浏览器打开：

`http://localhost:37788`

局域网另一台电脑打开：

`http://房主电脑的局域网IP:37788`

例如：

`http://192.168.1.23:37788`

## 如果启动失败

优先双击 `check_environment.bat`，它会检查 Node.js、npm 和 ws 依赖。

如果 `npm install` 失败，建议在此文件夹中手动打开命令提示符并执行：

```bat
npm install
node server.js
```

这样错误不会被窗口关闭带走。

## Windows 防火墙

如果房主自己的 `http://localhost:37788` 可以打开，但另一台电脑访问不了 `http://房主IP:37788`，通常需要允许 Node.js / 端口 37788 通过 Windows 专用网络防火墙。

## 停止服务器

服务器窗口中按 `Ctrl+C`。
