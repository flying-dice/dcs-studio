-- teaser-mod hello — run me in DCS with the Run button. The return value lands
-- in the Console, and the log line shows in the DCS Log viewer (filter:
-- teaser-mod). Hook-env (DCS.*, log.*), so it runs straight from the editor.
pcall(function()
  log.write("teaser-mod", log.INFO, "Hello, world from teaser-mod!")
end)
