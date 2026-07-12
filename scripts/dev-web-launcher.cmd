@echo off
rem English Oral Teacher Agent — dev-web launcher
rem Started at user logon by the "English Oral Teacher Agent - dev-web" task.
rem Opens a new titled cmd window running `pnpm dev-web`. Close the window
rem to stop the dev server.
start "dev-web [English Oral Teacher Agent]" /D "D:\English-oral-teacher-Agent" cmd /k "pnpm dev-web"
