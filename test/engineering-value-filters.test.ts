import assert from "node:assert/strict"
import { it } from "vitest"
import { CATEGORY_BY_PATH } from "../src/categories"
import { applyPostFilters, normalizeKeywordResponse } from "../src/normalize"
import { createSearchRequest } from "../src/search-request"
import type { NormalizedPart } from "../src/types"

const partWith = (
  parameters: Record<string, string>,
  id = "SYNTHETIC",
): NormalizedPart => {
  const [part] = normalizeKeywordResponse({
    Products: [
      {
        ManufacturerProductNumber: id,
        ProductVariations: [
          {
            DigiKeyProductNumber: `${id}-ND`,
            QuantityAvailableforPackageType: 1,
          },
        ],
        Parameters: Object.entries(parameters).map(([name, value]) => ({
          ParameterText: name,
          ValueText: value,
        })),
      },
    ],
  })
  assert.ok(part)
  return part
}

const cases: Array<[string, string, string, string, boolean]> = [
  ["rejects microfarads for nanofarads", "Capacitance", "100nF", "1uF", false],
  ["rejects ten microfarads", "Capacitance", "100nF", "10uF", false],
  ["rejects picofarads for nanofarads", "Capacitance", "100nF", "100pF", false],
  ["distinguishes picofarad values", "Capacitance", "1pF", "2pF", false],
  ["accepts equivalent microfarads", "Capacitance", "100nF", "0.1uF", true],
  ["accepts micro sign", "Capacitance", "100nF", "0.1µF", true],
  ["accepts Greek mu", "Capacitance", "100nF", "0.1μF", true],
  ["accepts equivalent farads", "Capacitance", "100nF", "0.0000001 F", true],
  ["keeps close small values", "Capacitance", "100nF", "100.05nF", true],
  ["rejects outside small tolerance", "Capacitance", "100nF", "100.2nF", false],
  ["is symmetric for small values", "Capacitance", "100.2nF", "100nF", false],
  ["keeps close large values", "Resistance", "10k", "10.005 kOhms", true],
  ["rejects outside large tolerance", "Resistance", "10k", "10.02 kOhms", false],
  ["rejects different large values", "Resistance", "10k", "20 kOhms", false],
  ["accepts equivalent ohms", "Resistance", "10k", "10000 Ohms", true],
  ["distinguishes sub-ohm values", "Resistance", "0.1", "0.2 Ohms", false],
  ["accepts equivalent milliohms", "Resistance", "100m", "0.1 Ohms", true],
  ["keeps close milliohm values", "Resistance", "100m", "100.05 mOhms", true],
  ["keeps equal zero values", "Capacitance", "0F", "0 F", true],
  ["rejects nonzero for zero", "Capacitance", "0F", "1nF", false],
  ["rejects zero for nonzero", "Capacitance", "1nF", "0 F", false],
  ["keeps signed zero equivalent", "Capacitance", "0F", "-0 F", true],
]

for (const [name, parameter, expected, actual, matches] of cases) {
  it(name, () => {
    const part = partWith({ [parameter]: actual })
    const filter = parameter === "Capacitance" ? "capacitance" : "resistance"

    assert.deepEqual(
      applyPostFilters([part], { [filter]: expected }),
      matches ? [part] : [],
    )
  })
}

it("applies the public 100nF category query to normalized product values", () => {
  const category = CATEGORY_BY_PATH.get("/capacitors/list")
  assert.ok(category)
  const request = createSearchRequest(
    new URL("https://example.test/capacitors/list?capacitance=100nF"),
    category,
  )
  assert.equal(request.query, "capacitor 100nF")
  assert.deepEqual(request.postFilters, { capacitance: "100nF" })

  const parts = [
    partWith({ Capacitance: "1uF" }, "WRONG-MICRO"),
    partWith({ Capacitance: "100nF" }, "MATCH-NANO"),
    partWith({ Capacitance: "0.1uF" }, "MATCH-MICRO"),
    partWith({ Capacitance: "10uF" }, "WRONG-TEN-MICRO"),
    partWith({ Capacitance: "100pF" }, "WRONG-PICO"),
  ]
  const before = structuredClone(parts)
  const selected = applyPostFilters(parts, request.postFilters)

  assert.deepEqual(selected, [parts[1], parts[2]])
  assert.equal(selected[0], parts[1])
  assert.equal(selected[1], parts[2])
  assert.deepEqual(parts, before)
})

it("combines capacitance and package filters", () => {
  const parts = [
    partWith({ Capacitance: "100nF", "Supplier Device Package": "0603" }, "A"),
    partWith({ Capacitance: "1uF", "Supplier Device Package": "0603" }, "B"),
    partWith({ Capacitance: "100nF", "Supplier Device Package": "0805" }, "C"),
  ]

  assert.deepEqual(
    applyPostFilters(parts, { capacitance: "100nF", package: "0603" }),
    [parts[0]],
  )
})

it("preserves the existing missing-parameter fallback", () => {
  const part = partWith({})

  assert.deepEqual(applyPostFilters([part], { capacitance: "100nF" }), [part])
})

it("preserves nonnumeric parameter matching", () => {
  const part = partWith({ Capacitance: "Not Specified" })

  assert.deepEqual(applyPostFilters([part], { capacitance: "specified" }), [
    part,
  ])
  assert.deepEqual(applyPostFilters([part], { capacitance: "100nF" }), [])
})

it("preserves case-insensitive textual filters", () => {
  const part = partWith({ Color: "Green" })

  assert.deepEqual(applyPostFilters([part], { color: "green" }), [part])
  assert.deepEqual(applyPostFilters([part], { color: "red" }), [])
})

it("preserves unfiltered array identity", () => {
  const parts = [partWith({ Capacitance: "100nF" })]

  assert.equal(applyPostFilters(parts, undefined), parts)
  assert.equal(applyPostFilters(parts, {}), parts)
})

it("preserves normalized parameter-name lookup", () => {
  const part = partWith({ CAPACITANCE: "0.1uF" })

  assert.deepEqual(applyPostFilters([part], { capacitance: "100nF" }), [part])
})
