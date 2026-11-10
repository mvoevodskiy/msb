// Журнал сервиса: одна строка на значимое событие в stdout (под systemd — в journald).
// Никаких токенов, паролей и содержимого снимка — только факты: что, сколько, с какого IP.

export type Log = (line: string) => void;

export const stdoutLog: Log = line => {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
};

export const silentLog: Log = () => {};
