export interface LogEntry {
  timestamp: Date;
  level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'SIGNAL';
  message: string;
}

const LOG_BUFFER: LogEntry[] = [];
const MAX_LOGS = 1000;

function formatTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function addToBuffer(entry: LogEntry): void {
  LOG_BUFFER.push(entry);
  if (LOG_BUFFER.length > MAX_LOGS) {
    LOG_BUFFER.shift();
  }
}

export const logger = {
  info(message: string): void {
    const entry: LogEntry = { timestamp: new Date(), level: 'INFO', message };
    addToBuffer(entry);
    console.log(`ℹ️  [${formatTimestamp(entry.timestamp)}] ${message}`);
  },

  warn(message: string): void {
    const entry: LogEntry = { timestamp: new Date(), level: 'WARN', message };
    addToBuffer(entry);
    console.warn(`⚠️  [${formatTimestamp(entry.timestamp)}] ${message}`);
  },

  error(message: string): void {
    const entry: LogEntry = { timestamp: new Date(), level: 'ERROR', message };
    addToBuffer(entry);
    console.error(`❌ [${formatTimestamp(entry.timestamp)}] ${message}`);
  },

  trade(message: string): void {
    const entry: LogEntry = { timestamp: new Date(), level: 'TRADE', message };
    addToBuffer(entry);
    console.log(`🎯 [${formatTimestamp(entry.timestamp)}] ${message}`);
  },

  signal(message: string): void {
    const entry: LogEntry = { timestamp: new Date(), level: 'SIGNAL', message };
    addToBuffer(entry);
    console.log(`📊 [${formatTimestamp(entry.timestamp)}] ${message}`);
  },

  getLogs(n: number = 100): LogEntry[] {
    return LOG_BUFFER.slice(-n);
  },
};
