# Vendor reference (open-core)

[← Открытое ядро](../OPEN-CORE.md) · [Reference tests](../tests/reference/README.md)

Контракты и вырезки, снятые при переносе с закрытого бандла. В рантайм не импортируются.

| Файл | Назначение |
|------|------------|
| `snippets/` | Вырезки ключевых участков с номерами строк |
| `CONTRACT-*.md` | Контракты подсистем (agent-cc, state/menus, autonomy) |
| `UI-SCREENS.md` / `UI-BUTTONS.tsv` | Эталон текстов и кнопок Telegram UI |

Закрытый бандл (`index.closed.js` / `deobfuscated.js`) и Jarvis OS-обвязка удалены —
остаётся только open-core + `msb-engine`. Полнота старого поведения проверяется
сценариями в [reference tests](../tests/reference/README.md), а не наличием vendor-файла.

Откат выпуска восстанавливает предыдущий код из [release backup](../../../tools/release/README.md),
а не из vendor.
