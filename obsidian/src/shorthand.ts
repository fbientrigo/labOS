/**
 * One-line capture shorthand for the LabOS note box. Pure: no Obsidian, no I/O.
 *
 *   #tag                         tag the entry (first one wins, stays in the text)
 *   !ok | !working | !broken | !fail   checkpoint
 *   !m 12mA [3.3V] [@target] note      measurement; @"two words" for spaced targets
 *
 * Commands need the leading "!". Anything else is a plain note.
 */

export type Shorthand =
  | { ok: true; kind: "note"; text: string; tag?: string }
  | { ok: true; kind: "checkpoint"; state: "working" | "broken"; text: string; tag?: string }
  | {
      ok: true;
      kind: "measurement";
      text: string;
      tag?: string;
      target: string;
      current: number;
      unit: "A" | "mA";
      voltage?: number;
    }
  | { ok: false; error: string };

const CHECKPOINTS: Record<string, "working" | "broken"> = {
  ok: "working",
  working: "working",
  broken: "broken",
  fail: "broken",
};

const squash = (value: string): string => value.replace(/\s+/g, " ").trim();

export function parseShorthand(input: string): Shorthand {
  const text = input.trim();
  const tag = /(?:^|\s)#([\w-]+)/.exec(text)?.[1];
  const command = /^!(\w+)(?=\s|$)/.exec(text)?.[1]?.toLowerCase();

  if (command && command in CHECKPOINTS) {
    return { ok: true, kind: "checkpoint", state: CHECKPOINTS[command]!, text: text.slice(command.length + 1).trim(), tag };
  }
  if (command !== "m") return { ok: true, kind: "note", text, tag };

  let rest = text.slice(2);
  let target = "setup";
  rest = rest.replace(/(?:^|\s)@(?:"([^"]+)"|(\S+))/, (_match, quoted?: string, bare?: string) => {
    target = quoted ?? bare ?? target;
    return " ";
  });
  let voltage: number | undefined;
  rest = rest.replace(/(?<![\w.])(-?\d+(?:\.\d+)?)\s*V(?![\w])/, (_match, value: string) => {
    voltage = Number(value);
    return " ";
  });
  const current = /(?<![\w.])(\d+(?:\.\d+)?)\s*(mA|A)(?![\w])/.exec(rest);
  if (!current) return { ok: false, error: "Measurement needs a current, e.g. !m 12mA" };
  rest = rest.replace(current[0], " ");
  return {
    ok: true,
    kind: "measurement",
    text: squash(rest),
    tag,
    target,
    current: Number(current[1]),
    unit: current[2] as "A" | "mA",
    voltage,
  };
}
