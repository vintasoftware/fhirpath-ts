/** Read a generated JSON template address, independently of FHIRPath's FHIR model. */
export function readTemplatePath({ fhirData, path }: { fhirData: unknown; path: string }): unknown[] {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[_A-Za-z][_A-Za-z0-9]*|\[\d+\])*$/.test(path)) {
    throw new Error(`Not a template JSON address: ${path}`)
  }
  const tokens = path.match(/[_A-Za-z][_A-Za-z0-9]*|\d+/g)!
  const root = tokens.shift()
  if (
    typeof fhirData !== 'object' ||
    fhirData === null ||
    !('resourceType' in fhirData) ||
    fhirData.resourceType !== root
  ) {
    throw new Error(`Template address ${path} does not match its resource`)
  }
  let values: unknown[] = [fhirData]
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      values = Number(token) < values.length ? [values[Number(token)]] : []
    } else {
      values = values.flatMap(value => {
        if (typeof value !== 'object' || value === null || !Object.hasOwn(value, token)) {
          return []
        }
        const child = (value as Record<string, unknown>)[token]
        return child == null ? [] : Array.isArray(child) ? child : [child]
      })
    }
  }
  return values
}
