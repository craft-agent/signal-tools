import { describe, expect, test } from "bun:test"
import { checkedCaption, checkedText } from "./arguments"
import { MAX_TEXT_CHARACTERS } from "./constants"

describe("checkedCaption", () => {
  test("trims the text, and is empty for none, blank or absent", () => {
    expect(checkedCaption("  here you go \n")).toBe("here you go")
    expect(checkedCaption(undefined)).toBe("")
    expect(checkedCaption("")).toBe("")
    expect(checkedCaption(" \n\t ")).toBe("")
  })

  test("takes the same number of code points as a text does, counted after trimming", () => {
    const longest = "😀".repeat(MAX_TEXT_CHARACTERS)
    expect(checkedCaption(` ${longest} `)).toBe(longest)
    expect(checkedText(longest)).toBe(longest)
    expect(() => checkedCaption(`${longest}x`)).toThrow(`at most ${MAX_TEXT_CHARACTERS}`)
    expect(() => checkedText(`${longest}x`)).toThrow(`at most ${MAX_TEXT_CHARACTERS}`)
  })

  test("a text, unlike a caption, may not be blank", () => {
    expect(() => checkedText("  ")).toThrow("blank")
  })
})
