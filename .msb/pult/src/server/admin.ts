// Команды администратора Пульта: node src/server/admin.ts --help
// Сами команды — в admin-cli.ts; здесь только заглушка предупреждения node:sqlite, чтобы вывод был чистым
// даже без --disable-warning (модули с node:sqlite поэтому подключаются динамически, после фильтра).

process.removeAllListeners('warning');
process.on('warning', w => {
  if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`);
});

const { runAdmin } = await import('./admin-cli.ts');
process.exitCode = await runAdmin(process.argv.slice(2));
