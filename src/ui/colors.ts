
const ESC = "\x1b[";

export interface ColorSupport {
  enabled: boolean;
}

export function isColorSupported(env: NodeJS.ProcessEnv = process.env, isTty?: boolean): boolean {
  if (env["NO_COLOR"]) return false;
  if (env["FORCE_COLOR"]) {
    const v = env["FORCE_COLOR"];
    if (v === "0" || v === "false") return false;
    return true;
  }
  if (isTty === undefined) {
    isTty = Boolean(process.stdout.isTTY);
  }
  return isTty;
}

function wrap(open: number, close: number): (s: string) => string {
  const start = `${ESC}${open}m`;
  const end = `${ESC}${close}m`;
  return (s: string) => `${start}${s}${end}`;
}

const noop = (s: string) => s;

export interface Palette {
  reset: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
}

export function createPalette(enabled: boolean): Palette {
  if (!enabled) {
    return {
      reset: noop, bold: noop, dim: noop,
      red: noop, green: noop, yellow: noop, cyan: noop, magenta: noop,
    };
  }
  return {
    reset: wrap(0, 0),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}
