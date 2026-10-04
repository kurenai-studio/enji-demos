import { DEBUG, PREVIEW } from "cc/env";
import { error, log, sys, warn } from "cc";

/** DEBUG/PREVIEW：镜像到 console，供 Remote Console / MCP get_logs 读取 */
const MIRROR_TO_CONSOLE = DEBUG || PREVIEW;

/**
 * 日誌工具類，提供統一的輸出格式（含時間戳與等級標記）。
 */
export class LogUtils {
    /**
     * 取得目前本地時間字串（用於作為日誌時間戳）。
     * @returns 本地時間的格式化字串
     */
    private static getTimeStamp(): string {
        return new Date().toLocaleString();
    }

    private static mirrorToConsole(level: "info" | "warn" | "error", stamp: string, label: string, args: unknown[]): void {
        if (!MIRROR_TO_CONSOLE || !sys.isBrowser || typeof console === "undefined") {
            return;
        }
        const prefix = `[${stamp}] ${label}`;
        const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
        fn(prefix, ...args);
    }

    /**
     * 輸出 Info 等級日誌。
     * 在輸出前會加上時間戳與 `INFO` 標記（綠色粗體），支援多個參數，參數會依序傳給 `cc.log`。
     * @param args 要輸出的任意數量參數
     */
    public static info(...args: any[]) {
        const stamp = this.getTimeStamp();
        log(`%c[${stamp}] INFO`, 'color: green; font-weight: bold;', ...args);
        this.mirrorToConsole("info", stamp, "INFO", args);
    }

    /**
     * 輸出 Warn 等級日誌。
     * 在輸出前會加上時間戳與 `WARN` 標記（橙色粗體），支援多個參數，參數會依序傳給 `cc.warn`。
     * @param args 要輸出的任意數量參數
     */
    public static warn(...args: any[]) {
        const stamp = this.getTimeStamp();
        warn(`%c[${stamp}] WARN`, 'color: orange; font-weight: bold;', ...args);
        this.mirrorToConsole("warn", stamp, "WARN", args);
    }

    /**
     * 輸出 Error 等級日誌。
     * 在輸出前會加上時間戳與 `ERROR` 標記（紅色粗體），支援多個參數，參數會依序傳給 `cc.error`。
     * @param args 要輸出的任意數量參數
     */
    public static error(...args: any[]) {
        const stamp = this.getTimeStamp();
        error(`%c[${stamp}] ERROR`, 'color: red; font-weight: bold;', ...args);
        this.mirrorToConsole("error", stamp, "ERROR", args);
    }
}
