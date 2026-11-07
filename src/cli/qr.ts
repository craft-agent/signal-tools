import { encode } from "uqr"

const UPPER_HALF_BLOCK = "▀"
const RESET = "\x1b[0m"

/** ANSI colors of a dark and a light module; both are set on every cell so the code reads the same on any theme. */
const DARK = { foreground: 30, background: 40 }
const LIGHT = { foreground: 97, background: 107 }

/**
 * Renders `text` as a QR code of half-block cells: two module rows to a text
 * line, the upper module as the foreground of `▀` and the lower as its
 * background. `border` is the width of the light margin around the code, which
 * a scanner needs. Every line ends with a reset.
 */
export function renderQr(text: string, border: number): string {
  const { data } = encode(text, { border })
  const lines: string[] = []
  for (let row = 0; row < data.length; row += 2) {
    const upper = data[row]!
    const lower = data[row + 1]
    let line = ""
    for (let column = 0; column < upper.length; column++) {
      const top = upper[column] ? DARK : LIGHT
      const bottom = lower?.[column] ? DARK : LIGHT
      line += `\x1b[${top.foreground};${bottom.background}m${UPPER_HALF_BLOCK}`
    }
    lines.push(line + RESET)
  }
  return lines.join("\n")
}
