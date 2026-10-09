/**
 * Exact corpus cases this engine intentionally diverges on, grouped by the
 * behavior family. Every entry names the fhirpath.js/fhirpath-py behavior we
 * do not inherit and the evidence for our reading. Keys are `${file}||${expression}`,
 * `${file}@${model}||${expression}` to match only cases run with that model
 * (`none` for model-free cases), or `${file}#${desc}||${expression}` to match one
 * of several cases with the same expression. The harness fails when an entry shields no case,
 * when a shielded case starts passing (stale), or when an unlisted case fails
 * (regression).
 */
export interface QuirkFamily {
  name: string
  evidence: string
  keys: string[]
}

export const QUIRK_FAMILIES: QuirkFamily[] = [
  {
    name: 'model-free-field-convention',
    evidence:
      'fhirpath.js pairs value/_value arrays and keeps null slots as items without a model. The FHIR JSON _property form is defined for FHIR data; knowing an element is a primitive requires the model, and the equivalent expressions pass here with { model: r4Model }.',
    keys: [
      '5.1_existence.yaml||Functions.collWith2NullAndTrue.subsetOf(Functions.collWithNullAndTrue)',
      '5.1_existence.yaml||Functions.collWithNullAndTrue.allFalse()',
      '5.1_existence.yaml||Functions.collWithNullAndTrue.allTrue()',
      '5.1_existence.yaml||Functions.collWithNullAndTrue.anyFalse()',
      '5.1_existence.yaml||Functions.collWithNullAndTrue.anyTrue()',
      '5.1_existence.yaml||Functions.collWithNullAndTrue.not()',
      '5.1_existence.yaml||Functions.collWithNullAndTrue.supersetOf(Functions.collWith2NullAndTrue)',
      '5.1_existence.yaml||Patient.name.given.distinct().count()',
      "5.1_existence.yaml||Patient.name.given[0].all(id = 'Jacomus1Id')",
      '5.2_filtering_and_projection.yaml||Patient.name.given.ofType(FHIR.string) = Patient.name.given.ofType(System.String)',
      "5.2_filtering_and_projection.yaml||Patient.name.given.where(id = 'Jacomus1Id').count()",
      '5.2_filtering_and_projection.yaml||heteroattr.ofType(Object)',
      '5.3_subsetting.yaml||(Functions.collWithNullsAndTrue[0] | Functions.collWithNullsAndTrue[1]).exclude(Functions.collWithNullsAndTrue[1]).id',
      '5.3_subsetting.yaml||Functions.collWithNullsAndTrue.first().id',
      '5.3_subsetting.yaml||Functions.collWithNullsAndTrue.last().id',
      '5.3_subsetting.yaml||Functions.collWithNullsAndTrue.single()',
      '5.3_subsetting.yaml||Functions.collWithNullsAndTrue.skip(2).id',
      '5.3_subsetting.yaml||Functions.collWithNullsAndTrue.tail()[1].id',
      '5.3_subsetting.yaml||Functions.collWithNullsAndTrue.take(1).id',
      '5.3_subsetting.yaml||Functions.collWithNullsAndTrue[0].single()',
      '5.4_combining.yaml||(Patient.name.given[0] | Patient.name.given[3]).count()',
      '5.4_combining.yaml||(Patient.name.given[0]).combine(Patient.name.given[3]).count()',
      '5.4_combining.yaml||Patient.name.given[0].union(Patient.name.given[3]).count()',
      '5.5_conversion.yaml||Functions.collWithNullsAndTrue[0].toBoolean()',
      '5.5_conversion.yaml||Functions.collWithNullsAndTrue[0].toDecimal()',
      '5.5_conversion.yaml||Functions.collWithNullsAndTrue[0].toInteger()',
      '5.5_conversion.yaml||Functions.collWithNullsAndTrue[0].toLong()',
      '5.5_conversion.yaml||Functions.collWithNullsAndTrue[0].toQuantity()',
      '5.5_conversion.yaml||Functions.iif(collWithNullsAndTrue[1], collWithNullsAndTrue[0], collWithNullsAndTrue[2]).id',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].abs()',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].ceiling()',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].exp()',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].floor()',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].ln()',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].log(2)',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].power(2)',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].round(2)',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].sqrt()',
      '5.7_math.yaml||Math.arrWithNullsAndVals[0].truncate()',
      '5.7_math.yaml||Math.d2.round(%context.arrWithNullsAndVals[0])',
      '5.7_math.yaml||Math.n4.power(%context.arrWithNullsAndVals[0])',
      '5.8_tree_navigation.yaml||Patient.children() = (Patient.birthDate | Patient.address | Patient.name | Patient.communication)',
      '5.8_tree_navigation.yaml||communication.children()[1] = communication.preferred',
      '6.1_equality.yaml||Bundle.entry[1].resource.name.given[0] = Bundle.entry[2].resource.name.given[0]',
      '6.4_collection.yaml||Patient.name.given contains Patient.name.given[3]',
      '6.4_collection.yaml||Patient.name.given[3] in Patient.name.given',
      '7_aggregate.yaml||Functions.collWithNull1.avg()',
      '7_aggregate.yaml||Functions.collWithNull1.max()',
      '7_aggregate.yaml||Functions.collWithNull1.min()',
      '7_aggregate.yaml||Functions.collWithNull2.avg()',
      '7_aggregate.yaml||Functions.collWithNull2.max()',
      '7_aggregate.yaml||Functions.collWithNull2.min()',
      '7_aggregate.yaml||Patient.name.given.sum()',
      "extensions.yaml||Functions.attrtrue.extension('url1').extension('url2').id = 'someid2'",
      "extensions.yaml||Functions.attrtrue.extension('url1').extension('url2').value = 'someuri'",
      "extensions.yaml||Functions.attrtrue.id = 'someid'",
      "extensions.yaml||Patient.address[1].id = 'someId'",
      "extensions.yaml||Patient.birthDate.extension .where(url = 'http://hl7.org/fhir/StructureDefinition/patient-birthTime') .valueDateTime.toDateTime() = @1974-12-25T14:35:45-05:00",
      "extensions.yaml||Patient.birthDate.extension('http://hl7.org/fhir/StructureDefinition/patient-birthTime') .valueDateTime.toDateTime() = @1974-12-25T14:35:45-05:00",
      "extensions.yaml||Patient.communication.preferred.extension('test').exists()",
      'extensions.yaml||Patient.name.given',
      'hasValue.yaml@none||Patient.birthDate.hasValue()',
      'simple.yaml||Patient.name.exists(given)',
      'simple.yaml||Patient.name.given.ofType(System.String)',
      'simple.yaml||Patient.name.given.ofType(string)',
      'simple.yaml||Patient.name.given.ofType(string)[0]',
      'simple.yaml||Patient.name.given.select($this.length) = Patient.name.given.select(length)',
    ],
  },
  {
    name: 'nested-extension-equality',
    evidence:
      "fhirpath.js's own equality still recurses into each primitive's raw _field extension wrapper when comparing a containing complex object, even with { model: r4Model } — it only strips extensions when comparing a bare primitive directly (see Bundle.entry[1].resource.name.given[0] = ... above, model-free-field-convention). Spec \"= (Equals)\" excludes extensions from a value's identity at every nesting depth, so this engine's = now matches its own ~ (which already ignored id/extension metadata) and ignores them however deep the comparison goes.",
    keys: ['6.1_equality.yaml||Bundle.entry[1] != Bundle.entry[2]'],
  },
  {
    name: 'year-month-definite-conversions',
    evidence:
      "fhirpath.js refuses UCUM a/mo conversions and duration ratios, and treats calendar month as 30 days. UCUM defines 'a' and 'mo' as definite Julian units, so this engine converts them exactly; the spec keeps calendar year/month indefinite (\"Time-valued Quantities\") and the official suite pins 1 year = 1 'a' as false.",
    keys: [
      "5.5_conversion.yaml||'1 \\'mo\\''.toQuantity('days')",
      "6.1_equality.yaml||1 'mo' = 30 days",
      '6.1_equality.yaml||1 month = 30 days',
      "6.2_comparision.yaml||1 'a' > 1 day",
      "6.2_comparision.yaml||1 'a'.comparable(1 seconds)",
      "6.6_math.yaml||(1 'a') / (1 year).toQuantity('seconds').toQuantity('s') = 1.0006849315068493",
      "6.6_math.yaml||(1 'a').toQuantity('s') + (1 year).toQuantity('seconds') = 63093600 's'",
      "6.6_math.yaml||(1 'a').toQuantity('s') - (1 year).toQuantity('seconds') = 21600 's'",
      "6.6_math.yaml||(1 'mo') / (1 year).toQuantity('seconds').toQuantity('s') = 0.08339041095890411",
      "6.6_math.yaml||(1 year + 6 months).toQuantity('seconds') + (1 'a').toQuantity('s') + (5 days).toQuantity('seconds') = (1 'a').toQuantity('s') + (6 months).toQuantity('seconds') + (1 year).toQuantity('seconds')",
      "6.6_math.yaml||(1 year).toQuantity('seconds') + (1 'a').toQuantity('s') = 63093600 seconds",
      "6.6_math.yaml||(1 year).toQuantity('seconds') + (6 'mo').toQuantity('s') + (1 'a').toQuantity('s') = (1 'a').toQuantity('s') + (6 'mo').toQuantity('s') + (1 year).toQuantity('seconds')",
      "6.6_math.yaml||(1 year).toQuantity('seconds') - (1 'a').toQuantity('s') = -21600 seconds",
      "6.6_math.yaml||(1 year).toQuantity('seconds').toQuantity('s') / (1 'a') = 0.999315537303217",
      "6.6_math.yaml||(1 year).toQuantity('seconds').toQuantity('s') / (1 'mo') = 11.991786447638603",
      "6.6_math.yaml||1 'a' + 1 second",
      "6.6_math.yaml||1 'a' - 1 second",
      "6.6_math.yaml||1 'a' / 1 second",
      "6.6_math.yaml||1 'a' / 1 year",
      "6.6_math.yaml||1 'kg' / 3 months",
      "6.6_math.yaml||1 'm' * (1 year).toQuantity('seconds').toQuantity('s') = 31536000 'm.s'",
      "6.6_math.yaml||1 'mo' / 1 year",
      '6.6_math.yaml||1 / 3 months',
      "6.6_math.yaml||1 month / 1 'mo'",
      "6.6_math.yaml||1 second - 1 'a'",
      "6.6_math.yaml||1 second / 1 'a'",
      "6.6_math.yaml||1 seconds + 1 'a'",
      "6.6_math.yaml||1 week / 1 'wk'",
      "6.6_math.yaml||1 year / 1 'a'",
      "6.6_math.yaml||1 year / 1 'mo'",
      '6.6_math.yaml||1 year / 6 months',
      "6.6_math.yaml||3 's' / 3 milliseconds",
      "6.6_math.yaml||3 minutes / 1 's'",
      '6.6_math.yaml||3 month / 2 year',
      '6.6_math.yaml||3 years / 1.5 years',
      "fhir-quantity.yaml||(30 days).toQuantity('mo').empty()",
      "fhir-quantity.yaml||@2025 + (Observation.value + 1 'a') = @2027",
      "fhir-quantity.yaml||@2025 + (Observation.value - 0 'a') = @2026",
      "fhir-quantity.yaml||Observation.value + 1 'a' = 2 'a'",
      "fhir-quantity.yaml||Observation.value = 1 'a'",
      "fhir-quantity.yaml||Observation.value.toQuantity('a') = 1 'a'",
      "fhir-quantity.yaml||Observation.value.toQuantity('mo') = 12 'mo'",
      "fhir-quantity.yaml||QuestionnaireResponse.item[0].answer.value != 2 'a'",
      "fhir-quantity.yaml||QuestionnaireResponse.item[0].answer.value = 2 'a'",
      "fhir-quantity.yaml||QuestionnaireResponse.item[0].answer.value.toQuantity('a') = 2 'a'",
    ],
  },
  {
    name: 'full-ucum-table',
    evidence:
      'Offset and logarithmic units (Cel, [degF], K, B) need a complete UCUM implementation \u2014 a deferred feature (README register).',
    keys: [
      "5.5_conversion.yaml||'0 \\'Cel\\''.toQuantity('K') = 273.15 'K'",
      "5.5_conversion.yaml||'23 \\'Cel\\''.toQuantity('[degF]') ~ 73.4 '[degF]'",
      "5.5_conversion.yaml||'73.4 \\'[degF]\\''.toQuantity('Cel') ~ 23 'Cel'",
      "6.1_equality.yaml||0 'Cel' ~ 273.15 'K'",
      "6.1_equality.yaml||23 'Cel' ~ 73.4 '[degF]'",
      "6.1_equality.yaml||73.4 '[degF]' ~ 23 'Cel'",
      "6.2_comparision.yaml||0 'Cel' <= 273.15 'K'",
      "6.2_comparision.yaml||0 'Cel' >= 273.15 'K'",
      "6.2_comparision.yaml||23 'Cel' < 72 '[degF]'",
      "6.2_comparision.yaml||23 'Cel' > 72 '[degF]'",
      "6.6_math.yaml||1 'B' * 2",
      "6.6_math.yaml||1 'B' + 1 'B'",
      "6.6_math.yaml||1 'B' - 1 'B'",
      "6.6_math.yaml||1 'B' / 2",
      "6.6_math.yaml||1 'B' / 2 '1'",
    ],
  },
  {
    name: 'equivalence-rounding',
    evidence:
      'fhirpath.js rounds decimal ~ to (least precision \u2212 1) digits; spec "~ (Equivalent)" says "the precision of the least precise operand". Its complex-value ~ inherits the same rounding.',
    keys: [
      '6.1_equality.yaml||0.00000011 ~ 0.00000010',
      '6.1_equality.yaml||1.1 ~ 1.0',
      '6.1_equality.yaml||1.1 ~ 1.00',
      '6.1_equality.yaml||1.10 ~ 1.00',
      '6.1_equality.yaml||1.100 ~ 1.101',
      "6.1_equality.yaml||4 'g' !~ 4040 'mg'",
      '6.1_equality.yaml||Ops.complex ~ Ops.complexsimilar',
    ],
  },
  {
    name: 'math-functions-on-quantities',
    evidence:
      "1.1 'kg'.ceiling() works in fhirpath.js, as FHIRPath 3.0.0 allows (\"Math\": ceiling() takes a Quantity); this engine does not yet (#134).",
    keys: [
      "5.7_math.yaml||(-1.56 's').truncate() = -1 's'",
      "5.7_math.yaml||1.1 'kg'.ceiling() = 2 'kg'",
      "5.7_math.yaml||2.315 's'.round(2) = 2.32 's'",
      "5.7_math.yaml||2.5 's'.floor() = 2 's'",
    ],
  },
  {
    name: 'component-functions-parse-strings',
    evidence:
      "'2014-01-05'.yearOf() parses the string in fhirpath.js; FHIRPath 3.0.0's component functions take Date/DateTime/Time input, so non-temporal input is empty here.",
    keys: [
      "5.9_utility_functions.yaml||'2012-01-01T12:30:00.000+08:45'.timezoneOffsetOf()",
      "5.9_utility_functions.yaml||'2012-01-01T12:30:00.000-07:00'.dateOf()",
      "5.9_utility_functions.yaml||'2012-01-01T12:30:00.000-07:00'.timeOf()",
      "5.9_utility_functions.yaml||'2014-01-05T10:30:00.000'.dayOf()",
      "5.9_utility_functions.yaml||'2014-01-05T10:30:00.000'.hourOf()",
      "5.9_utility_functions.yaml||'2014-01-05T10:30:00.000'.minuteOf()",
      "5.9_utility_functions.yaml||'2014-01-05T10:30:00.000'.monthOf()",
      "5.9_utility_functions.yaml||'2014-01-05T10:30:00.000'.yearOf()",
      "5.9_utility_functions.yaml||'2014-01-05T10:30:00.123+10:00'.millisecondOf()",
      "5.9_utility_functions.yaml||'2014-01-05T10:30:40.000'.secondOf()",
    ],
  },
  {
    name: 'long-conversion-quirks',
    evidence:
      'fhirpath.js cannot convert Longs to quantities and unwraps dimensionless quantities for div/mod; this engine accepts Longs everywhere numbers go and keeps div/mod Integer/Decimal-only.',
    keys: [
      "5.5_conversion.yaml||1L.toQuantity() = 1 '1'",
      "6.6_math.yaml||4 '1' div 2L = 2",
      "6.6_math.yaml||5 '1' mod 2L = 1",
    ],
  },
  {
    name: 'comparable-edge-behaviors',
    evidence:
      'fhirpath.js errors on year operands of comparable() and returns false for empty input; comparability is dimension-based here and empty input propagates.',
    keys: [
      "6.2_comparision.yaml||1 year.comparable(1 's')",
      '6.2_comparision.yaml||Observation.value.comparable(1 year)',
      '6.2_comparision.yaml||i.comparable(2 years)',
    ],
  },
  {
    name: 'leap-second-arithmetic',
    evidence:
      'fhirpath.js clamps :60 to :59 while adding; this engine accepts second 60 (FHIR time regex) and adds through it.',
    keys: ['6.6_math.yaml||@T23:59:60 + 1 minute = @T00:00:59'],
  },
  {
    name: 'time-units-on-dates',
    evidence:
      'fhirpath.js converts hours to days when adding them to a Date. The FHIRPath 3.0.0 Date/Time Arithmetic table allows only years, months, weeks, and days for a Date and makes an unsupported unit for the type an error; N1 lists the same Date units.',
    keys: [
      '6.6_math.yaml||@2016-01 + 1 hour',
      '6.6_math.yaml||@2016-01-01 + 24 hours',
      '6.6_math.yaml||@2016-01-01 + 47 hours',
    ],
  },
  {
    name: 'plural-unit-rendering',
    evidence:
      'fhirpath.js prints "180 hours"; this engine prints the canonical singular calendar keyword. Both spellings parse back identically.',
    keys: ['6.6_math.yaml||1 year + 6 months', '6.6_math.yaml||12 hours + 7 days', '6.6_math.yaml||7 days + 12 hours'],
  },
  {
    name: 'lenient-invalid-json-unescape',
    evidence:
      "unescape('json') on malformed content passes through in fhirpath.js; it is rejected here (no defined result in the spec).",
    keys: ["5.6_string_manipulation.yaml||'\\\\1<2\\\\'.unescape('json')"],
  },
  {
    name: 'negative-round-precision',
    evidence: 'round(-2) is a fhirpath.js extension; spec "Math" round() precision is a count of decimal places, at least 0.',
    keys: ['5.7_math.yaml||Math.d2.round(n2)'],
  },
  {
    name: 'suffixed-choice-keys',
    evidence:
      'fhirpath.js reads effectiveDateTime directly; official testPolymorphismB pins suffixed choice keys as semantic errors.',
    keys: ['6.2_comparision.yaml||DiagnosticReport.issued < DiagnosticReport.effectiveDateTime'],
  },
  {
    name: 'fhir-quantity-dual-identity',
    evidence:
      "fhirpath.js lets a FHIR Quantity with UCUM code 'a' answer both as 1 year and as 1 'a'; the FHIR fhirpath page maps UCUM time codes to calendar durations one way.",
    keys: [
      'fhir-quantity.yaml||QuestionnaireResponse.item[2].answer.value.toQuantity()',
      'fhir-quantity.yaml||QuestionnaireResponse.item[3].answer.value.toQuantity()',
    ],
  },
  {
    name: 'deferred-factory-api',
    evidence: 'The %factory type-factory API (R5 draft, maturity 0) is a deferred feature — see the README register.',
    keys: [
      "6.1_equality.yaml||(%factory.date('2024-01-01', %factory.Extension('someExt', 'someString')) =\n %factory.date('2024-01-01', %factory.Extension('someExt', 'someString'))) |\n(%factory.date('2024-01-01', %factory.Extension('someExt', 'someString1')) =\n %factory.date('2024-01-01', %factory.Extension('someExt', 'someString2')))",
      "factory.yaml||%factory.Address('5 Nowhere Road' | 'second line', 'SomeCity', 'EW', '0000', {}, 'home', 'physical').where(line = ('5 Nowhere Road' | 'second line') and city = 'SomeCity' and state = 'EW' and postalCode = '0000' and country.empty() and use = 'home' and type = 'physical') is Address",
      "factory.yaml||%factory.CodeableConcept(%factory.Coding('system1', '1') | %factory .Coding('system2', '2'), 'Example Test').where(coding.code = '1' | '2' and text = 'Example Test') is CodeableConcept",
      "factory.yaml||%factory.Coding('http://loinc.org', '1234-5', 'An example test', '1.02').where(system = 'http://loinc.org' and code = '1234-5' and display = 'An example test' and version = '1.02') is Coding",
      "factory.yaml||%factory.ContactPoint('email', 'coyote@acme.com', 'work').where( system = 'email' and value = 'coyote@acme.com' and use = 'work' ) is ContactPoint",
      "factory.yaml||%factory.Extension('someExt', %factory.code('some code')).where($this is Extension and $this.valueCode is code).value = 'some code'",
      "factory.yaml||%factory.Extension('someExt', 'someString').where($this is Extension and $this.valueString is string).value = 'someString'",
      "factory.yaml||%factory.Extension('someExt', 11).where($this is Extension and $this.valueInteger is integer).value = 11",
      "factory.yaml||%factory.Extension('someExt', 11.1).where($this is Extension and $this.valueDecimal is decimal).value = 11.1",
      "factory.yaml||%factory.HumanName('Smith', 'Julia' | 'A', {}, {}, 'Julia Smith').where( family = 'Smith' and given = ('Julia' | 'A') and prefix.empty() and suffix.empty() and text = 'Julia Smith' and use.empty() ) is HumanName",
      "factory.yaml||%factory.Identifier('someSystem', 'someValue', 'someUse', %factory .create(CodeableConcept)).where($this.system = 'someSystem' and $this.value = 'someValue' and $this.use = 'someUse' and $this.type is CodeableConcept) is Identifier",
      "factory.yaml||%factory.Identifier({}, 'someValue', 'someUse', %factory .create(CodeableConcept)).where($this.system.empty() and $this.value = 'someValue' and $this.use = 'someUse' and $this.type is CodeableConcept) is Identifier",
      "factory.yaml||%factory.Quantity('http://unitsofmeasure.org', 'mg/dL', '5.03', 'mg/dL').where(system = 'http://unitsofmeasure.org' and code = 'mg/dL') = 5.03 'mg/dL'",
      "factory.yaml||%factory.Quantity('http://unitsofmeasure.org', 'mg/dL', 5.03, 'mg/dL') = 5.03 'mg/dL'",
      "factory.yaml||%factory.Quantity({}, 'mg/dL', 5.03, 'mg/dL').where(system.empty()) is Quantity",
      "factory.yaml||%factory.base64Binary('ZHNmZHNm').where($this is base64Binary) .decode('base64')",
      "factory.yaml||%factory.base64Binary('ZHNmZHNm', %factory.Extension('someExt', 'someString')).extension('someExt').value = 'someString'",
      "factory.yaml||%factory.boolean('false', %factory.Extension('someExt', 'someString')).where($this is boolean and $this = false) .extension('someExt').value = 'someString'",
      'factory.yaml||%factory.boolean(true).where($this is boolean)',
      "factory.yaml||%factory.canonical('someUrl').where($this is canonical)",
      "factory.yaml||%factory.canonical('someUrl', %factory.Extension('someExt', 'someString')).where($this is canonical and $this = 'someUrl') .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.code('some code').where($this is code)",
      "factory.yaml||%factory.code('some code', %factory.Extension('someExt', 'someString')).where($this is code and $this = 'some code') .extension('someExt').value = 'someString'",
      'factory.yaml||%factory.create(integer) is FHIR.integer',
      "factory.yaml||%factory.date('2024-01-01').where($this is date) = @2024-01-01",
      "factory.yaml||%factory.date('2024-01-01', %factory.Extension('someExt', 'someString')).where($this is date and $this = @2024-01-01) .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.dateTime('2024-01-01T01:01:01').where($this is dateTime) = @2024-01-01T01:01:01",
      "factory.yaml||%factory.dateTime('2024-01-01T01:01:01', %factory.Extension('someExt', 'someString')).where($this is dateTime and $this = @2024-01-01T01:01:01) .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.decimal('1.1', %factory.Extension('someExt', 'someString')) .where($this is decimal and $this = 1.1).extension('someExt').value = 'someString'",
      'factory.yaml||%factory.decimal(1.1).where($this is decimal)',
      "factory.yaml||%factory.id('someId-123').where($this is id) = 'someId-123'",
      "factory.yaml||%factory.id('someId-123', %factory.Extension('someExt', 'someString')).where($this is id and $this = 'someId-123') .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.instant('2024-01-01T01:01:01+01:00').where($this is instant) = @2024-01-01T01:01:01+01:00",
      "factory.yaml||%factory.instant('2024-01-01T01:01:01+01:00', %factory.Extension('someExt', 'someString')).where($this is instant and $this = @2024-01-01T01:01:01+01:00) .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.integer(-134, %factory.Extension('someExt', 'someString')) .where($this is integer and $this = -134) .extension('someExt').value = 'someString'",
      'factory.yaml||%factory.integer(134).where($this is integer)',
      "factory.yaml||%factory.markdown(' md md ').where($this is markdown)",
      "factory.yaml||%factory.markdown(' md md ', %factory.Extension('someExt', 'someString')) .where($this is markdown and $this = ' md md ') .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.oid('urn:oid:1.2.3').where($this is oid)",
      "factory.yaml||%factory.oid('urn:oid:1.2.3', %factory.Extension('someExt', 'someString')) .where($this is oid and $this = 'urn:oid:1.2.3') .extension('someExt').value = 'someString'",
      'factory.yaml||%factory.positiveInt(134).where($this is positiveInt)',
      "factory.yaml||%factory.positiveInt(134, %factory.Extension('someExt', 'someString')) .where($this is positiveInt and $this = 134) .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.string('some string').where($this is string)",
      "factory.yaml||%factory.string('some string', %factory.Extension('someExt', 'someString')) .where($this is string and $this = 'some string') .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.time('10:00').where($this is time) =  @T10:00",
      "factory.yaml||%factory.time('10:00', %factory.Extension('someExt', 'someString')) .where($this is time and $this = @T10:00) .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.unsignedInt(0, %factory.Extension('someExt', 'someString')) .where($this is unsignedInt and $this = 0) .extension('someExt').value = 'someString'",
      'factory.yaml||%factory.unsignedInt(134).where($this is unsignedInt)',
      "factory.yaml||%factory.uri('', %factory.Extension('someExt', 'someString')) .where($this is uri and $this = '') .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.uri('/something').where($this is uri)",
      "factory.yaml||%factory.url('', %factory.Extension('someExt', 'someString')) .where($this is url and $this = '') .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.url('/something').where($this is url)",
      "factory.yaml||%factory.uuid('urn:uuid:c757873d-ec9a-4326-a141-556f43239520') .where($this is uuid)",
      "factory.yaml||%factory.uuid('urn:uuid:c757873d-ec9a-4326-a141-556f43239520', %factory.Extension('someExt', 'someString')).where($this is uuid and $this = 'urn:uuid:c757873d-ec9a-4326-a141-556f43239520') .extension('someExt').value = 'someString'",
      "factory.yaml||%factory.withExtension(%factory.integer(134, %factory.Extension( 'someExt1', 'someString')), 'someExt2', 1).extension.value = 'someString' | 1",
      "factory.yaml||%factory.withExtension(%factory.integer({}), 'someExt', 1).extension( 'someExt').value = 1",
      "factory.yaml||%factory.withProperty(%factory.integer(134, %factory.Extension( 'someExt1', 'someString')), 'id', 'someId').where(extension.value = 'someString').id = 'someId'",
    ],
  },
  {
    name: 'empty-operand-error',
    evidence:
      'Cases disabled upstream that expect an error for an empty operand. Spec "Math" operators return empty when either operand is empty, and the same file expects [] for n1 + n4.',
    keys: [
      '6.6_math.yaml#** Error adding missing numbers||n1 + n4',
      '6.6_math.yaml||MathTestData.n1 div MathTestData.n4',
      '6.6_math.yaml||MathTestData.n1 mod MathTestData.n4',
    ],
  },
  {
    name: 'too-many-values-singletons',
    evidence:
      'A case disabled upstream that expects a too-many-values error, but a and h are single integers (1 and 2) in the test data, so a <= h is true; the same file expects [true].',
    keys: ['6.2_comparision.yaml#less than equal, with too many values||a <= h'],
  },
]

/** Models the engine does not ship yet; cases are skipped with this reason. */
export const SKIPPED_MODELS: Readonly<Record<string, string>> = {
  r5: 'needs the R5 model package (deferred; the R4 model ships first)',
  stu3: 'STU3 model is out of scope',
  dstu2: 'DSTU2 model is out of scope',
}

/**
 * Corpus files that copy official-suite cases. `official.test.ts` runs those
 * cases directly, with the suite's modes and skips, so cases disabled upstream
 * in these files stay skipped here.
 */
export const OFFICIAL_SUITE_COPIES: readonly string[] = ['fhir-r4.yaml', 'fhir-r5.yaml']
