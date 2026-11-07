import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, type ToolSpec } from "../core"
import { PROFILE } from "./testing"
import type { V1ToolContext, V2Context, V2Tool } from "./types"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"

describe("OpenCode state_dir setting", () => {
  const SESSION_ID = "ses_state"

  function stateTool(recorder: { target?: string; execute?: string }): ToolSpec {
    return defineTool({
      id: "demo_state_tool",
      title: "State Tool",
      description: "State Tool",
      toolset: "alpha",
      class: "add",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async targets(_args, ctx) {
        recorder.target = ctx.stateDir
        return ["target-resource"]
      },
      async execute(_args, ctx) {
        recorder.execute = ctx.stateDir
        return { ok: true }
      },
    })
  }

  function downloadTool(recorder: { target?: string; execute?: string }): ToolSpec {
    return defineTool({
      id: "demo_download_tool",
      title: "Download Tool",
      description: "Download Tool",
      toolset: "alpha",
      class: "add",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async targets(_args, ctx) {
        recorder.target = ctx.downloadDir
        return ["target-resource"]
      },
      async execute(_args, ctx) {
        recorder.execute = ctx.downloadDir
        return { ok: true }
      },
    })
  }

  describe("V1", () => {
    test("passes stateDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const context: V1ToolContext = {
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        async ask() {},
      }
      const { tool } = await createV1Server([stateTool(recorder)], { profile: PROFILE })(
        {},
        { state_dir: "/v1/custom/state" },
      )
      await tool.demo_state_tool!.execute({}, context)
      expect(recorder.target).toBe("/v1/custom/state")
      expect(recorder.execute).toBe("/v1/custom/state")
    })

    test("falls back to environment variable DEMO_STATE_DIR", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const context: V1ToolContext = {
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        async ask() {},
      }
      const { tool } = await createV1Server([stateTool(recorder)], {
        profile: PROFILE,
        env: { DEMO_STATE_DIR: "/v1/env/state" },
      })({}, {})
      await tool.demo_state_tool!.execute({}, context)
      expect(recorder.target).toBe("/v1/env/state")
      expect(recorder.execute).toBe("/v1/env/state")
    })

    test("rejects an invalid state_dir option", async () => {
      const server = createV1Server([], { profile: PROFILE })
      await expect(server({}, { state_dir: 123 })).rejects.toThrow('Option "state_dir"')
      await expect(server({}, { state_dir: "relative/path" })).rejects.toThrow('Option "state_dir"')
    })

    test("passes downloadDir from options into runTool, and rejects an invalid download_dir option", async () => {
      let seen: string | undefined
      const spec = defineTool({
        id: "demo_state_tool",
        title: "State Tool",
        description: "State Tool",
        toolset: "alpha",
        class: "add",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async execute(_args, ctx) {
          seen = ctx.downloadDir
          return { ok: true }
        },
      })
      const context: V1ToolContext = {
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        async ask() {},
      }
      const server = createV1Server([spec], { profile: PROFILE })
      const { tool } = await server({}, { download_dir: "/v1/custom/downloads" })
      await tool.demo_state_tool!.execute({}, context)
      expect(seen).toBe("/v1/custom/downloads")
      await expect(server({}, { download_dir: "relative/path" })).rejects.toThrow('Option "download_dir"')
    })
  })

  describe("V2", () => {
    test("passes stateDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const tools = new Map<string, V2Tool>()
      const ctx: V2Context = {
        options: { state_dir: "/v2/custom/state" },
        session: {
          async get() {
            return { location: { directory: "/work/project" } }
          },
        },
        permission: {
          async assert() {},
        },
        tool: { transform: async (cb) => cb({ add: (t) => tools.set(t.name, t) }) },
        skill: { transform: async () => {} },
      }
      await createV2Setup([stateTool(recorder)], { profile: PROFILE })(ctx)
      const signal = new AbortController().signal
      await tools.get("demo_state_tool")!.execute({}, { sessionID: SESSION_ID, signal })
      expect(recorder.target).toBe("/v2/custom/state")
      expect(recorder.execute).toBe("/v2/custom/state")
    })

    function v2Context(options: Record<string, unknown>, tools: Map<string, V2Tool>): V2Context {
      return {
        options,
        session: {
          async get() {
            return { location: { directory: "/work/project" } }
          },
        },
        permission: { async assert() {} },
        tool: { transform: async (cb) => cb({ add: (t) => tools.set(t.name, t) }) },
        skill: { transform: async () => {} },
      }
    }

    test("names the program in the context of both calls", async () => {
      const programs: Array<string | undefined> = []
      const spec = defineTool({
        id: "demo_program_tool",
        title: "Program Tool",
        description: "Program Tool",
        toolset: "alpha",
        class: "add",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async targets(_args, ctx) {
          programs.push(ctx.programName)
          return ["target-resource"]
        },
        async execute(_args, ctx) {
          programs.push(ctx.programName)
          return { ok: true }
        },
      })
      const tools = new Map<string, V2Tool>()
      await createV2Setup([spec], { profile: PROFILE })(v2Context({}, tools))
      await tools.get("demo_program_tool")!.execute({}, { sessionID: SESSION_ID, signal: new AbortController().signal })
      expect(programs).toEqual(["signal-tools", "signal-tools"])
    })

    test("passes downloadDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const tools = new Map<string, V2Tool>()
      await createV2Setup([downloadTool(recorder)], { profile: PROFILE })(
        v2Context({ download_dir: "/v2/custom/downloads" }, tools),
      )
      const signal = new AbortController().signal
      await tools.get("demo_download_tool")!.execute({}, { sessionID: SESSION_ID, signal })
      expect(recorder.target).toBe("/v2/custom/downloads")
      expect(recorder.execute).toBe("/v2/custom/downloads")
    })

    test("falls back to environment variable DEMO_DOWNLOAD_DIR for downloadDir", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const tools = new Map<string, V2Tool>()
      await createV2Setup([downloadTool(recorder)], {
        profile: PROFILE,
        env: { DEMO_DOWNLOAD_DIR: "/v2/env/downloads" },
      })(v2Context({}, tools))
      const signal = new AbortController().signal
      await tools.get("demo_download_tool")!.execute({}, { sessionID: SESSION_ID, signal })
      expect(recorder.target).toBe("/v2/env/downloads")
      expect(recorder.execute).toBe("/v2/env/downloads")
    })

    test("rejects an invalid download_dir option", async () => {
      const setup = createV2Setup([], { profile: PROFILE })
      await expect(setup(v2Context({ download_dir: "relative/path" }, new Map()))).rejects.toThrow(
        'Option "download_dir"',
      )
      await expect(setup(v2Context({ download_dir: 7 }, new Map()))).rejects.toThrow('Option "download_dir"')
    })

    test("rejects an invalid state_dir option", async () => {
      const ctx: V2Context = {
        options: { state_dir: "relative/path" },
        session: {
          async get() {
            return {}
          },
        },
        permission: { async assert() {} },
        tool: { transform: async () => {} },
        skill: { transform: async () => {} },
      }
      await expect(createV2Setup([], { profile: PROFILE })(ctx)).rejects.toThrow('Option "state_dir"')
    })
  })
})
