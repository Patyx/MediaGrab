@echo off
rem Removes the MediaGrab Helper registration and files (yt-dlp/ffmpeg included).
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mediagrab.helper" /f >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\MediaGrab\helper" >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\MediaGrab\bin" >nul 2>&1
echo MediaGrab Helper removed. (Last-folder memory in %LOCALAPPDATA%\MediaGrab\state.json was kept.)
pause
