import { describe, expect, test } from "bun:test"
import { encode } from "uqr"
import { renderQr } from "./qr"

const TEXT = "sgnl://linkdevice?uuid=fake-device&pub_key=fake-key"
const BORDER = 2
const CELL = /\x1b\[(\d+);(\d+)m▀/g

describe("renderQr", () => {
  const { size, data } = encode(TEXT, { border: BORDER })
  const lines = renderQr(TEXT, BORDER).split("\n")

  test("uses one text line for two module rows", () => {
    expect(lines).toHaveLength(Math.ceil(size / 2))
  })

  test("ends every line with a reset and has one cell per column", () => {
    for (const line of lines) {
      expect(line.endsWith("\x1b[0m")).toBe(true)
      expect([...line.matchAll(CELL)]).toHaveLength(size)
    }
  })

  test("decodes back to the modules, with a light row below an odd last row", () => {
    const decoded: boolean[][] = []
    for (const line of lines) {
      const upper: boolean[] = []
      const lower: boolean[] = []
      for (const [, foreground, background] of line.matchAll(CELL)) {
        expect(["30", "97"]).toContain(foreground!)
        expect(["40", "107"]).toContain(background!)
        upper.push(foreground === "30")
        lower.push(background === "40")
      }
      decoded.push(upper, lower)
    }
    if (size % 2 === 1) {
      expect(decoded.pop()!.some(Boolean)).toBe(false)
    }
    expect(decoded).toEqual(data)
  })
})
