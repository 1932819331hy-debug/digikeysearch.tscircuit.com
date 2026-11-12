import { getLinuxProcessorInfo } from "./linux-capable-processors"
import type {
  DigiKeyKeywordResponse,
  DigiKeyProduct,
  DigiKeyProductVariation,
  NormalizedPart,
} from "./types"

const normalizeWhitespace = (value: string | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim()

const getParameters = (product: DigiKeyProduct): Record<string, string> => {
  const parameters: Record<string, string> = {}
  for (const parameter of product.Parameters ?? []) {
    const name = normalizeWhitespace(parameter.ParameterText)
    const value = normalizeWhitespace(parameter.ValueText)
    if (name && value) parameters[name] = value
  }
  return parameters
}

const getPreferredVariation = (
  product: DigiKeyProduct,
): DigiKeyProductVariation | undefined =>
  [...(product.ProductVariations ?? [])]
    .filter((variation) => !variation.MarketPlace)
    .sort(
      (a, b) =>
        (b.QuantityAvailableforPackageType ?? 0) -
          (a.QuantityAvailableforPackageType ?? 0) ||
        (a.MinimumOrderQuantity ?? Number.MAX_SAFE_INTEGER) -
          (b.MinimumOrderQuantity ?? Number.MAX_SAFE_INTEGER),
    )[0] ?? product.ProductVariations?.[0]

const getUnitPrice = (
  product: DigiKeyProduct,
  variation: DigiKeyProductVariation | undefined,
): number => {
  if (typeof product.UnitPrice === "number") return product.UnitPrice

  const pricing = [...(variation?.StandardPricing ?? [])].sort(
    (a, b) => (a.BreakQuantity ?? 0) - (b.BreakQuantity ?? 0),
  )
  return (
    pricing.find((price) => typeof price.UnitPrice === "number")?.UnitPrice ?? 0
  )
}

export const normalizeProduct = (
  product: DigiKeyProduct,
): NormalizedPart | null => {
  const variation = getPreferredVariation(product)
  const digikeyProductNumber = normalizeWhitespace(
    variation?.DigiKeyProductNumber,
  )
  const manufacturerPartNumber = normalizeWhitespace(
    product.ManufacturerProductNumber,
  )

  if (!digikeyProductNumber || !manufacturerPartNumber) return null

  const parameters = getParameters(product)
  const packageName =
    parameters["Package / Case"] ??
    parameters.Package ??
    parameters["Supplier Device Package"] ??
    ""
  const variationStock = variation?.QuantityAvailableforPackageType ?? 0
  const category = normalizeWhitespace(product.Category?.Name)

  return {
    digikey_product_number: digikeyProductNumber,
    supplier_part_number: digikeyProductNumber,
    mfr: manufacturerPartNumber,
    manufacturer: normalizeWhitespace(product.Manufacturer?.Name),
    package: normalizeWhitespace(packageName),
    description: normalizeWhitespace(product.Description?.ProductDescription),
    detailed_description: normalizeWhitespace(
      product.Description?.DetailedDescription,
    ),
    stock: variationStock || product.QuantityAvailable || 0,
    price: getUnitPrice(product, variation),
    category,
    subcategory: category,
    product_url: product.ProductUrl ?? "",
    datasheet_url: product.DatasheetUrl ?? "",
    photo_url: product.PhotoUrl ?? "",
    normally_stocking: Boolean(product.NormallyStocking),
    discontinued: Boolean(product.Discontinued || product.EndOfLife),
    marketplace: Boolean(variation?.MarketPlace),
    parameters,
  }
}

export const normalizeKeywordResponse = (
  response: DigiKeyKeywordResponse,
): NormalizedPart[] => {
  const seen = new Set<string>()
  const parts: NormalizedPart[] = []

  for (const product of [
    ...(response.ExactMatches ?? []),
    ...(response.Products ?? []),
  ]) {
    const part = normalizeProduct(product)
    if (!part || seen.has(part.digikey_product_number)) continue
    seen.add(part.digikey_product_number)
    parts.push(part)
  }

  return parts.sort((a, b) => b.stock - a.stock)
}

export const toSearchText = (part: NormalizedPart): string =>
  [
    part.digikey_product_number,
    part.mfr,
    part.manufacturer,
    part.description,
    part.detailed_description,
    part.package,
    part.category,
    ...Object.entries(part.parameters).flat(),
  ]
    .join(" ")
    .toLowerCase()

const parseEngineeringValue = (raw: string): number | null => {
  const match = raw
    .trim()
    .replaceAll(",", "")
    .match(/^(-?\d+(?:\.\d+)?)\s*([TGMkmunpµμ]?)/)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const multiplier: Record<string, number> = {
    T: 1e12,
    G: 1e9,
    M: 1e6,
    k: 1e3,
    m: 1e-3,
    u: 1e-6,
    µ: 1e-6,
    μ: 1e-6,
    n: 1e-9,
    p: 1e-12,
  }
  return value * (multiplier[match[2]] ?? 1)
}

const normalizedTokens = (value: string): string[] =>
  value.toLowerCase().match(/[a-z]+|\d+/g) ?? []

const matchesPackage = (part: NormalizedPart, expected: string): boolean => {
  const supplierPackage = part.parameters["Supplier Device Package"]
  const packageValues = supplierPackage
    ? [supplierPackage]
    : [part.parameters["Package / Case"], part.package].filter(
        (value): value is string => Boolean(value),
      )
  const expectedTokens = normalizedTokens(expected)
  return packageValues.some((value) => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "")
    return expectedTokens.every((token) => normalized.includes(token))
  })
}

const PARAMETER_NAMES: Record<string, string[]> = {
  resistance: ["Resistance"],
  capacitance: ["Capacitance"],
  color: ["Color"],
  pitch: ["Pitch"],
  num_pins: ["Number of Positions", "Number of Contacts", "Positions"],
  number_of_contacts: [
    "Number of Contacts",
    "Number of Positions",
    "Positions",
  ],
  connector_type: ["Connector Type"],
  mounting_style: ["Mounting Type"],
  gender: ["Connector Type", "Gender"],
  memory_type: ["Memory Type", "Technology"],
  memory_size: ["Memory Size", "Density"],
}

const parseMillimeters = (value: string): number | null => {
  const match = value.trim().match(/(-?\d+(?:\.\d+)?)\s*(?:mm)?/i)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

const getDiameterMillimeters = (
  part: NormalizedPart,
  diameter: "ID" | "OD",
): number[] => {
  const text = [
    part.parameters["Industry Recognized Mating Diameter"],
    part.parameters["Actual Diameter"],
  ]
    .filter(Boolean)
    .join(" ")

  const pattern = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*mm\\s*${diameter}\\b`, "gi")
  return Array.from(text.matchAll(pattern), (match) => Number(match[1])).filter(
    Number.isFinite,
  )
}

const matchesDiameter = (
  part: NormalizedPart,
  diameter: "ID" | "OD",
  expected: string,
): boolean => {
  const expectedMm = parseMillimeters(expected)
  if (expectedMm === null) return false
  return getDiameterMillimeters(part, diameter).some(
    (actual) => Math.abs(actual - expectedMm) < 0.001,
  )
}

const matchesBarrelJack = (part: NormalizedPart): boolean => {
  const connectorType = part.parameters["Connector Type"]?.trim().toLowerCase()
  if (connectorType !== "jack") return false

  const hasBarrelDimensions =
    getDiameterMillimeters(part, "ID").length > 0 &&
    getDiameterMillimeters(part, "OD").length > 0
  return (
    hasBarrelDimensions ||
    /\b(?:dc\s+power|barrel)\s+jack\b/i.test(toSearchText(part))
  )
}

const matchesDram = (part: NormalizedPart): boolean => {
  const technology = [
    part.parameters["Memory Type"],
    part.parameters.Technology,
  ]
    .filter(Boolean)
    .join(" ")
  const searchableText = toSearchText(part)
  const isDram = /\b(?:lp)?ddr[2-5x]*\b|\bsdram\b|\bdram\b/i.test(
    `${technology} ${searchableText}`,
  )
  const isModuleOrConnector =
    /\b(?:memory\s+module|dimm|sodimm|connector)\b/i.test(
      `${part.category} ${part.description} ${part.detailed_description}`,
    )
  return isDram && !isModuleOrConnector
}

const matchesParameter = (
  part: NormalizedPart,
  filterName: string,
  expected: string,
): boolean => {
  if (
    filterName === "chip_family" ||
    filterName === "architecture" ||
    filterName === "cpu_core"
  ) {
    const actual = part[filterName]
    if (!actual) return false
    if (filterName === "architecture") {
      return actual.toLowerCase() === expected.trim().toLowerCase()
    }
    const expectedTokens = normalizedTokens(expected).join(" ")
    return (
      expectedTokens.length > 0 &&
      ` ${normalizedTokens(actual).join(" ")} `.includes(` ${expectedTokens} `)
    )
  }
  if (filterName === "barrel_jack") {
    return expected === "true" && matchesBarrelJack(part)
  }
  if (filterName === "dram") {
    return expected === "true" && matchesDram(part)
  }
  if (filterName === "inside_diameter_mm") {
    return matchesDiameter(part, "ID", expected)
  }
  if (filterName === "outside_diameter_mm") {
    return matchesDiameter(part, "OD", expected)
  }

  const values = (PARAMETER_NAMES[filterName] ?? [filterName]).flatMap(
    (name) => {
      const exact = part.parameters[name]
      if (exact) return [exact]
      const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "")
      return Object.entries(part.parameters)
        .filter(
          ([candidate]) =>
            candidate.toLowerCase().replace(/[^a-z0-9]/g, "") ===
            normalizedName,
        )
        .map(([, value]) => value)
    },
  )
  if (values.length === 0) return true

  const expectedNumber = parseEngineeringValue(expected)
  return values.some((value) => {
    const actualNumber = parseEngineeringValue(value)
    if (expectedNumber !== null && actualNumber !== null) {
      const scale = Math.max(
        Math.abs(expectedNumber),
        Math.abs(actualNumber),
      )
      return (
        scale === 0 ||
        Math.abs(expectedNumber - actualNumber) / scale < 0.001
      )
    }
    return value.toLowerCase().includes(expected.toLowerCase())
  })
}

export const applyPostFilters = (
  parts: NormalizedPart[],
  filters: Record<string, string> | undefined,
): NormalizedPart[] => {
  if (!filters || Object.keys(filters).length === 0) return parts
  let candidates = parts
  if ("linux_capable_processor" in filters) {
    if (filters.linux_capable_processor !== "true") return []
    candidates = parts.flatMap((part) => {
      const info = getLinuxProcessorInfo(part)
      return info && part.stock > 0 && !part.marketplace
        ? [{ ...part, ...info }]
        : []
    })
  }
  return candidates.filter((part) =>
    Object.entries(filters).every(([name, expected]) =>
      name === "linux_capable_processor"
        ? true
        : name === "package"
          ? matchesPackage(part, expected)
          : matchesParameter(part, name, expected),
    ),
  )
}
