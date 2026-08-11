import type { R4Bases, R4Elements, R4ReferenceTargets, R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'
import type {
  CompactCalendarUnit,
  CompactFastFunctionName,
  CompactFunctionRules,
  CompactInfixParselets,
  CompactLambdaArgument0Name,
  CompactLambdaArgument1Name,
  CompactLambdaArgument2Name,
  CompactOperatorRules,
  CompactPrefixParselets,
  CompactTypeOperatorRules,
} from './generated/metadata-compact.ts'

type NameToken = ['name', string]
type KeywordToken = ['keyword', string]
type SymbolToken = ['symbol', string]
type LiteralToken = ['string' | 'number' | 'date' | 'dateTime' | 'time', string]
type SpecialToken = ['special', 'this' | 'index' | 'total']
type UnsafeToken = ['unsafe', string]
type TypeToken = NameToken | KeywordToken | SymbolToken | LiteralToken | SpecialToken | UnsafeToken
type TypeTokens = TypeToken[]
type ScanFailure = { readonly opaque: true }

type Letter =
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
  | '_'

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type HexDigit = Digit | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
type IdentifierPart = Letter | Digit
type Whitespace = ' ' | '\t' | '\r' | '\n' | '\f'
type Keyword = 'and' | 'or' | 'xor' | 'implies' | 'div' | 'mod' | 'in' | 'contains' | 'is' | 'as' | 'true' | 'false'
type OneCharacterSymbol =
  '=' | '~' | '<' | '>' | '+' | '-' | '*' | '|' | '&' | '(' | ')' | '[' | ']' | '{' | '}' | '.' | ',' | '%'
type SimpleEscape = "'" | '"' | '`' | '/' | '\\' | 'f' | 'n' | 'r' | 't'

type Step<Steps extends unknown[]> = [...Steps, 0]

/** A semantic-token and source-step bounded tokenizer matching the runtime vocabulary. */
type Tokenize<Source extends string> = Scan<Source, [], []>

type Scan<Source extends string, Tokens extends TypeTokens, Steps extends unknown[]> = Source extends ''
  ? Tokens
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends Whitespace
        ? Scan<Rest, Tokens, Step<Steps>>
        : Character extends Letter
          ? ReadIdentifier<Rest, Character, Tokens, Step<Steps>>
          : Character extends Digit
            ? ReadNumber<Rest, Character, Tokens, Step<Steps>>
            : Character extends "'"
              ? ReadQuoted<Rest, '', "'", 'string', Tokens, Step<Steps>>
              : Character extends '`'
                ? ReadQuoted<Rest, '', '`', 'name', Tokens, Step<Steps>>
                : Character extends '@'
                  ? ReadTemporal<Rest, '', Tokens, Step<Steps>>
                  : Character extends '$'
                    ? ReadSpecial<Rest, '', Tokens, Step<Steps>>
                    : Character extends '/'
                      ? ScanAfterSlash<Rest, Tokens, Step<Steps>>
                      : Character extends '!'
                        ? ScanAfterBang<Rest, Tokens, Step<Steps>>
                        : Character extends '<' | '>'
                          ? ScanComparison<Rest, Character, Tokens, Step<Steps>>
                          : Character extends OneCharacterSymbol
                            ? EmitAndScan<Rest, ['symbol', Character], Tokens, Step<Steps>>
                            : ScanFailure
      : ScanFailure

type ReadIdentifier<
  Source extends string,
  Acc extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? EmitFinal<Acc extends Keyword ? ['keyword', Acc] : ['name', Acc], Tokens>
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends IdentifierPart
        ? ReadIdentifier<Rest, `${Acc}${Character}`, Tokens, Step<Steps>>
        : EmitAndScan<Source, Acc extends Keyword ? ['keyword', Acc] : ['name', Acc], Tokens, Steps>
      : ScanFailure

type ReadNumber<
  Source extends string,
  Acc extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? EmitFinal<['number', Acc], Tokens>
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends Digit
        ? ReadNumber<Rest, `${Acc}${Character}`, Tokens, Step<Steps>>
        : Character extends 'L'
          ? EmitAndScan<Rest, ['number', `${Acc}L`], Tokens, Step<Steps>>
          : Character extends '.'
            ? Rest extends `${infer Fraction}${string}`
              ? Fraction extends Digit
                ? ReadFraction<Rest, `${Acc}.`, Tokens, Step<Steps>>
                : EmitAndScan<Source, ['number', Acc], Tokens, Steps>
              : EmitAndScan<Source, ['number', Acc], Tokens, Steps>
            : EmitAndScan<Source, ['number', Acc], Tokens, Steps>
      : ScanFailure

type ReadFraction<
  Source extends string,
  Acc extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? EmitFinal<['number', Acc], Tokens>
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends Digit
        ? ReadFraction<Rest, `${Acc}${Character}`, Tokens, Step<Steps>>
        : EmitAndScan<Source, ['number', Acc], Tokens, Steps>
      : ScanFailure

type ReadQuoted<
  Source extends string,
  Acc extends string,
  Quote extends "'" | '`',
  Kind extends 'string' | 'name' | 'unsafe',
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? ScanFailure
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends Quote
        ? EmitAndScan<
            Rest,
            Kind extends 'string' ? ['string', Acc] : Kind extends 'name' ? ['name', Acc] : ['unsafe', Acc],
            Tokens,
            Step<Steps>
          >
        : Character extends '\\'
          ? ReadEscape<Rest, Acc, Quote, Kind, Tokens, Step<Steps>>
          : ReadQuoted<Rest, `${Acc}${Character}`, Quote, Kind, Tokens, Step<Steps>>
      : ScanFailure

type ReadEscape<
  Source extends string,
  Acc extends string,
  Quote extends "'" | '`',
  Kind extends 'string' | 'name' | 'unsafe',
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? ScanFailure
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends 'u'
        ? ReadUnicodeEscape<Rest, Acc, Quote, Kind, Tokens, Step<Steps>, []>
        : Character extends SimpleEscape
          ? ReadQuoted<Rest, `${Acc}${Escaped<Character>}`, Quote, Kind, Tokens, Step<Steps>>
          : ScanFailure
      : ScanFailure

type ReadUnicodeEscape<
  Source extends string,
  Acc extends string,
  Quote extends "'" | '`',
  Kind extends 'string' | 'name' | 'unsafe',
  Tokens extends TypeTokens,
  Steps extends unknown[],
  Digits extends unknown[],
> = Digits['length'] extends 4
  ? ReadQuoted<Source, `${Acc}${string}`, Quote, Kind extends 'name' ? 'unsafe' : Kind, Tokens, Steps>
  : Source extends ''
    ? ScanFailure
    : Steps['length'] extends 256
      ? ScanFailure
      : Source extends `${infer Character}${infer Rest}`
        ? Character extends HexDigit
          ? ReadUnicodeEscape<Rest, Acc, Quote, Kind, Tokens, Step<Steps>, [...Digits, 0]>
          : ScanFailure
        : ScanFailure

type Escaped<Character extends SimpleEscape> = Character extends 'f'
  ? '\f'
  : Character extends 'n'
    ? '\n'
    : Character extends 'r'
      ? '\r'
      : Character extends 't'
        ? '\t'
        : Character

type ReadTemporal<
  Source extends string,
  _Acc extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends `T${infer Rest}`
  ? Steps['length'] extends 256
    ? ScanFailure
    : ReadClock<Rest, 'T', Tokens, Step<Steps>, 'time'>
  : ReadFixedDigits<Source, '', Steps, [], 4> extends infer Year
    ? Year extends [infer Rest extends string, infer Value extends string, infer NextSteps extends unknown[]]
      ? ReadDateAfterYear<Rest, Value, Tokens, NextSteps>
      : ScanFailure
    : ScanFailure

type ReadDateAfterYear<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends `-${infer Rest}`
  ? HasTwoDigits<Rest> extends true
    ? Steps['length'] extends 256
      ? ScanFailure
      : ReadFixedDigits<Rest, `${Value}-`, Step<Steps>, [], 2> extends infer Month
        ? Month extends [infer Tail extends string, infer NextValue extends string, infer NextSteps extends unknown[]]
          ? ReadDateAfterMonth<Tail, NextValue, Tokens, NextSteps>
          : ScanFailure
        : ScanFailure
    : FinishDate<Source, Value, Tokens, Steps>
  : FinishDate<Source, Value, Tokens, Steps>

type ReadDateAfterMonth<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends `-${infer Rest}`
  ? HasTwoDigits<Rest> extends true
    ? Steps['length'] extends 256
      ? ScanFailure
      : ReadFixedDigits<Rest, `${Value}-`, Step<Steps>, [], 2> extends infer Day
        ? Day extends [infer Tail extends string, infer NextValue extends string, infer NextSteps extends unknown[]]
          ? FinishDate<Tail, NextValue, Tokens, NextSteps>
          : ScanFailure
        : ScanFailure
    : FinishDate<Source, Value, Tokens, Steps>
  : FinishDate<Source, Value, Tokens, Steps>

type FinishDate<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends `T${infer Rest}`
  ? Steps['length'] extends 256
    ? ScanFailure
    : Rest extends `${infer First}${string}`
      ? First extends Digit
        ? ReadClock<Rest, `${Value}T`, Tokens, Step<Steps>, 'dateTime'>
        : EmitTemporal<Rest, ['dateTime', `${Value}T`], Tokens, Step<Steps>>
      : EmitFinal<['dateTime', `${Value}T`], Tokens>
  : EmitTemporal<Source, ['date', Value], Tokens, Steps>

type ReadClock<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
  Kind extends 'time' | 'dateTime',
> =
  ReadFixedDigits<Source, Value, Steps, [], 2> extends infer Hour
    ? Hour extends [infer Rest extends string, infer NextValue extends string, infer NextSteps extends unknown[]]
      ? ReadClockAfterHour<Rest, NextValue, Tokens, NextSteps, Kind>
      : ScanFailure
    : ScanFailure

type ReadClockAfterHour<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
  Kind extends 'time' | 'dateTime',
> = Source extends `:${infer Rest}`
  ? HasTwoDigits<Rest> extends true
    ? Steps['length'] extends 256
      ? ScanFailure
      : ReadFixedDigits<Rest, `${Value}:`, Step<Steps>, [], 2> extends infer Minute
        ? Minute extends [infer Tail extends string, infer NextValue extends string, infer NextSteps extends unknown[]]
          ? ReadClockAfterMinute<Tail, NextValue, Tokens, NextSteps, Kind>
          : ScanFailure
        : ScanFailure
    : FinishClock<Source, Value, Tokens, Steps, Kind>
  : FinishClock<Source, Value, Tokens, Steps, Kind>

type ReadClockAfterMinute<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
  Kind extends 'time' | 'dateTime',
> = Source extends `:${infer Rest}`
  ? HasTwoDigits<Rest> extends true
    ? Steps['length'] extends 256
      ? ScanFailure
      : ReadFixedDigits<Rest, `${Value}:`, Step<Steps>, [], 2> extends infer Second
        ? Second extends [infer Tail extends string, infer NextValue extends string, infer NextSteps extends unknown[]]
          ? ReadClockFraction<Tail, NextValue, Tokens, NextSteps, Kind>
          : ScanFailure
        : ScanFailure
    : FinishClock<Source, Value, Tokens, Steps, Kind>
  : FinishClock<Source, Value, Tokens, Steps, Kind>

type ReadClockFraction<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
  Kind extends 'time' | 'dateTime',
> = Source extends `.${infer Rest}`
  ? Rest extends `${infer First}${string}`
    ? First extends Digit
      ? Steps['length'] extends 256
        ? ScanFailure
        : ReadFractionDigits<Rest, `${Value}.`, Tokens, Step<Steps>, Kind>
      : FinishClock<Source, Value, Tokens, Steps, Kind>
    : FinishClock<Source, Value, Tokens, Steps, Kind>
  : FinishClock<Source, Value, Tokens, Steps, Kind>

type ReadFractionDigits<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
  Kind extends 'time' | 'dateTime',
> = Source extends `${infer Character}${infer Rest}`
  ? Character extends Digit
    ? Steps['length'] extends 256
      ? ScanFailure
      : ReadFractionDigits<Rest, `${Value}${Character}`, Tokens, Step<Steps>, Kind>
    : FinishClock<Source, Value, Tokens, Steps, Kind>
  : FinishClock<'', Value, Tokens, Steps, Kind>

type FinishClock<
  Source extends string,
  Value extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
  Kind extends 'time' | 'dateTime',
> = Kind extends 'time'
  ? EmitTemporal<Source, ['time', Value], Tokens, Steps>
  : Source extends `Z${infer Rest}`
    ? Steps['length'] extends 256
      ? ScanFailure
      : EmitTemporal<Rest, ['dateTime', `${Value}Z`], Tokens, Step<Steps>>
    : Source extends `${infer Sign}${infer Rest}`
      ? Sign extends '+' | '-'
        ? HasOffsetTail<Rest> extends true
          ? ConsumeCharacters<Source, Steps, [], 6> extends infer Offset
            ? Offset extends [infer Tail extends string, infer NextSteps extends unknown[]]
              ? EmitTemporal<Tail, ['dateTime', Value], Tokens, NextSteps>
              : ScanFailure
            : ScanFailure
          : EmitTemporal<Source, ['dateTime', Value], Tokens, Steps>
        : EmitTemporal<Source, ['dateTime', Value], Tokens, Steps>
      : EmitFinal<['dateTime', Value], Tokens>

type ReadFixedDigits<
  Source extends string,
  Value extends string,
  Steps extends unknown[],
  Seen extends unknown[],
  Count extends number,
> = Seen['length'] extends Count
  ? [Source, Value, Steps]
  : Source extends `${infer Character}${infer Rest}`
    ? Character extends Digit
      ? Steps['length'] extends 256
        ? ScanFailure
        : ReadFixedDigits<Rest, `${Value}${Character}`, Step<Steps>, [...Seen, 0], Count>
      : ScanFailure
    : ScanFailure

type HasTwoDigits<Source extends string> = Source extends `${infer First}${infer Rest}`
  ? First extends Digit
    ? Rest extends `${infer Second}${string}`
      ? Second extends Digit
        ? true
        : false
      : false
    : false
  : false

type TwoDigitRest<Source extends string> = Source extends `${infer First}${infer Rest}`
  ? First extends Digit
    ? Rest extends `${infer Second}${infer Tail}`
      ? Second extends Digit
        ? Tail
        : never
      : never
    : never
  : never

type HasOffsetTail<Source extends string> =
  TwoDigitRest<Source> extends infer AfterHour
    ? [AfterHour] extends [never]
      ? false
      : AfterHour extends `:${infer AfterColon}`
        ? [TwoDigitRest<AfterColon>] extends [never]
          ? false
          : true
        : false
    : false

type ConsumeCharacters<
  Source extends string,
  Steps extends unknown[],
  Seen extends unknown[],
  Count extends number,
> = Seen['length'] extends Count
  ? [Source, Steps]
  : Source extends `${infer _Character}${infer Rest}`
    ? Steps['length'] extends 256
      ? ScanFailure
      : ConsumeCharacters<Rest, Step<Steps>, [...Seen, 0], Count>
    : ScanFailure

type EmitTemporal<
  Source extends string,
  Token extends LiteralToken,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends '' ? EmitFinal<Token, Tokens> : EmitAndScan<Source, Token, Tokens, Steps>

type ReadSpecial<
  Source extends string,
  Acc extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? EmitSpecial<Acc, '', Tokens, Steps>
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends IdentifierPart
        ? ReadSpecial<Rest, `${Acc}${Character}`, Tokens, Step<Steps>>
        : EmitSpecial<Acc, Source, Tokens, Steps>
      : ScanFailure

type EmitSpecial<
  Name extends string,
  Rest extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Name extends 'this' | 'index' | 'total'
  ? Rest extends ''
    ? EmitFinal<['special', Name], Tokens>
    : EmitAndScan<Rest, ['special', Name], Tokens, Steps>
  : ScanFailure

type ScanAfterSlash<Source extends string, Tokens extends TypeTokens, Steps extends unknown[]> = Source extends ''
  ? EmitFinal<['symbol', '/'], Tokens>
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends '/'
        ? SkipLineComment<Rest, Tokens, Step<Steps>>
        : Character extends '*'
          ? SkipBlockComment<Rest, Tokens, Step<Steps>>
          : EmitAndScan<Source, ['symbol', '/'], Tokens, Steps>
      : ScanFailure

type SkipLineComment<Source extends string, Tokens extends TypeTokens, Steps extends unknown[]> = Source extends ''
  ? Tokens
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends '\n'
        ? Scan<Rest, Tokens, Step<Steps>>
        : SkipLineComment<Rest, Tokens, Step<Steps>>
      : ScanFailure

type SkipBlockComment<Source extends string, Tokens extends TypeTokens, Steps extends unknown[]> = Source extends ''
  ? ScanFailure
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends '*'
        ? SkipBlockCommentAfterStar<Rest, Tokens, Step<Steps>>
        : SkipBlockComment<Rest, Tokens, Step<Steps>>
      : ScanFailure

type SkipBlockCommentAfterStar<
  Source extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? ScanFailure
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends '/'
        ? Scan<Rest, Tokens, Step<Steps>>
        : Character extends '*'
          ? SkipBlockCommentAfterStar<Rest, Tokens, Step<Steps>>
          : SkipBlockComment<Rest, Tokens, Step<Steps>>
      : ScanFailure

type ScanAfterBang<Source extends string, Tokens extends TypeTokens, Steps extends unknown[]> = Source extends ''
  ? ScanFailure
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends '=' | '~'
        ? EmitAndScan<Rest, ['symbol', `!${Character}`], Tokens, Step<Steps>>
        : ScanFailure
      : ScanFailure

type ScanComparison<
  Source extends string,
  Operator extends '<' | '>',
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? EmitFinal<['symbol', Operator], Tokens>
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends '='
        ? EmitAndScan<Rest, ['symbol', `${Operator}=`], Tokens, Step<Steps>>
        : EmitAndScan<Source, ['symbol', Operator], Tokens, Steps>
      : ScanFailure

type EmitAndScan<
  Source extends string,
  Token extends TypeToken,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Tokens['length'] extends 64 ? ScanFailure : Scan<Source, [...Tokens, Token], Steps>

type EmitFinal<Token extends TypeToken, Tokens extends TypeTokens> = Tokens['length'] extends 64
  ? ScanFailure
  : [...Tokens, Token]

type Cardinality = true | false | 'unknown'
type CoreState = [types: string, single: Cardinality, targets: string, rawInput: boolean, atom: string]
type VariableBinding = [name: string, value: CoreState]
type VariableBindings = VariableBinding[]
type BindingState = VariableBindings | 'opaque'
type InferenceEnvironment = [bindings: BindingState, rootTypes: string, rootSingle: Cardinality, rootTargets: string]
type DefaultEnvironment = [[], 'unknown', 'unknown', never]
type EnvironmentCarrier<Environment extends InferenceEnvironment> = { readonly __environment: Environment }
type InferenceState = CoreState
type OpaqueCore = ['opaque', 'unknown', never, false, never]
type UnknownCore = ['unknown', 'unknown', never, false, never]
type EmptyCore = [never, true, never, false, never]
type OpaqueState = OpaqueCore
type UnknownState = UnknownCore
type EmptyState = EmptyCore
type CoreOf<State extends InferenceState> = [State[0], State[1], State[2], State[3], State[4]]
type EnvironmentOf<State extends InferenceState> =
  State extends EnvironmentCarrier<infer Environment> ? Environment : DefaultEnvironment
type BindingsOf<State extends InferenceState> = EnvironmentOf<State>[0]
type RootTypesOf<State extends InferenceState> = EnvironmentOf<State>[1]
type RootSingleOf<State extends InferenceState> = EnvironmentOf<State>[2]
type RootTargetsOf<State extends InferenceState> = EnvironmentOf<State>[3]
type CopyEnvironment<State extends CoreState, Environment extends InferenceState> =
  Environment extends EnvironmentCarrier<infer Existing> ? State & EnvironmentCarrier<Existing> : State
type IsOpaqueState<State extends InferenceState> = [State[0]] extends [never]
  ? false
  : State[0] extends 'opaque'
    ? true
    : false
type IsUnknownState<State extends InferenceState> = [State[0]] extends [never]
  ? false
  : State[0] extends 'unknown'
    ? true
    : false
type Values = InferenceState[]
type BinaryOperatorFrame = ['binary', string, number, InferenceState]
type UnaryOperatorFrame = ['unary', '+' | '-', number]
type OperatorFrame = BinaryOperatorFrame | UnaryOperatorFrame
type Operators = OperatorFrame[]
type GroupFrame = ['group', Values, Operators, InferenceState]
type IndexFrame = ['index', Values, Operators, InferenceState, InferenceState]
type CallFrame = ['call', Values, Operators, InferenceState, InferenceState, string, InferenceState[]]
type DelimiterFrame = GroupFrame | IndexFrame | CallFrame
type Frames = DelimiterFrame[]
type ParseMode = 'operand' | 'operator' | 'member'

type TypeInfixParselets = CompactInfixParselets
type TypeFunctionRules = CompactFunctionRules
type TypeOperatorRules = CompactOperatorRules
type TypeTypeOperatorRules = CompactTypeOperatorRules
type TypePrefixParselets = CompactPrefixParselets
type FastMiss = { readonly fastMiss: true }
type FastFunctionName = CompactFastFunctionName

/** Parse and infer one expression without retaining an intermediate type-level AST. */
export type InferTypeExpression<Expression extends string, Input extends string> =
  FastExpression<Expression, Input> extends infer Fast
    ? Fast extends CoreState
      ? PublicResult<Fast>
      : InferSlowExpression<Expression, Input>
    : unknown[]

type InferSlowExpression<Expression extends string, Input extends string> =
  Tokenize<Expression> extends infer Tokens
    ? Tokens extends TypeTokens
      ? NeedsTokenPolicy<Expression> extends true
        ? TokenPolicy<Tokens> extends infer Policy
          ? Policy extends 'unsafe'
            ? unknown[]
            : Policy extends 'binding-fallback'
              ? InferParsed<Tokens, Input, false, true>
              : InferParsed<Tokens, Input, Policy extends 'environment' ? true : false>
          : unknown[]
        : InferParsed<Tokens, Input, false>
      : unknown[]
    : unknown[]

type NeedsTokenPolicy<Expression extends string> = Expression extends
  `${string}%${string}` | `${string}defineVariable${string}` | `${string}\\u${string}`
  ? true
  : false

type InferParsed<
  Tokens extends TypeTokens,
  Input extends string,
  TrackEnvironment extends boolean,
  BindingFallback extends boolean = false,
> =
  ParseLoop<Tokens, [], [], [], InputState<Input, TrackEnvironment, BindingFallback>, 'operand'> extends infer Result
    ? Result extends InferenceState
      ? PublicResult<Result>
      : unknown[]
    : unknown[]

/**
 * Model-known chains use a bounded shortcut. Four unrestricted steps may be
 * followed by two zero-argument calls. Generated name-length assertions keep
 * every accepted source below both scanner caps. Anything with general argument
 * syntax, operators, trivia, or unknown names takes the tokenizer and stack
 * parser above.
 */
type FastExpression<Expression extends string, Input extends string> = Expression extends `${infer Root}.${infer Rest}`
  ? Root extends keyof R4Resources & string
    ? FastChain<Rest, [Root, true, never, false, Root], []>
    : FastInputChain<Expression, Input>
  : Expression extends keyof R4Resources & string
    ? [Expression, true, never, false, Expression]
    : FastInputChain<Expression, Input>

type FastInputChain<Expression extends string, Input extends string> =
  FastInputState<Input> extends infer Context extends CoreState
    ? Context[0] extends 'unknown' | 'opaque'
      ? FastMiss
      : FastChain<Expression, Context, []>
    : FastMiss

type FastChain<Expression extends string, State extends CoreState, Steps extends unknown[]> = Steps['length'] extends 6
  ? FastMiss
  : Steps['length'] extends 4
    ? FastNoArgumentTail<Expression> extends true
      ? FastChainStep<Expression, State, Steps>
      : FastMiss
    : FastChainStep<Expression, State, Steps>

type FastNoArgumentTail<Expression extends string> = Expression extends `${infer First}().${infer Second}()`
  ? First extends FastFunctionName
    ? Second extends FastFunctionName
      ? true
      : false
    : false
  : Expression extends `${infer Only}()`
    ? Only extends FastFunctionName
      ? true
      : false
    : false

type FastChainStep<
  Expression extends string,
  State extends CoreState,
  Steps extends unknown[],
> = Expression extends `${infer Segment}.${infer Rest}`
  ? FastStep<Segment, State> extends infer Next
    ? Next extends CoreState
      ? FastChain<Rest, Next, [...Steps, 0]>
      : FastMiss
    : FastMiss
  : FastStep<Expression, State>

type FastStep<Segment extends string, State extends CoreState> = Segment extends `${infer Name}[${infer Index}]`
  ? Index extends Digit
    ? FastNavigate<State, Name>
    : FastMiss
  : Segment extends `${infer Name}()`
    ? Name extends FastFunctionName
      ? FastCallResult<FastApplyCall<State, Name, []>>
      : FastMiss
    : Segment extends `${infer Name}(${infer Argument})`
      ? Name extends 'ofType' | 'as'
        ? Argument extends keyof R4TypeOf & string
          ? ShortText<Argument, 32> extends true
            ? FastCallResult<FastApplyCall<State, Name, [['unknown', 'unknown', never, false, Argument]]>>
            : FastMiss
          : FastMiss
        : Name extends 'select'
          ? IdentifierText<Argument> extends true
            ? FastNavigate<FastSetSingle<State, true>, Argument> extends infer Projection
              ? Projection extends CoreState
                ? FastCallResult<FastApplyCall<State, Name, [Projection]>>
                : FastMiss
              : FastMiss
            : FastMiss
          : Name extends FastFunctionName
            ? FastArgumentShape<Argument> extends true
              ? ShortSafeArgument<Argument> extends true
                ? FastCallResult<FastApplyCall<State, Name, [UnknownCore]>>
                : FastMiss
              : FastMiss
            : FastMiss
      : FastNavigate<State, Segment>

type FastNavigate<State extends CoreState, Name extends string> =
  FastNavigateState<State, Name> extends infer Result
    ? Result extends CoreState
      ? Result[0] extends 'unknown' | 'opaque'
        ? FastMiss
        : Result
      : FastMiss
    : FastMiss

type FastNavigateState<Input extends CoreState, Element extends string> = [Input[0]] extends [never]
  ? EmptyCore
  : Input[0] extends 'opaque'
    ? OpaqueCore
    : Input[0] extends 'unknown'
      ? UnknownCore
      : ElementInformation<Input[0], Element> extends infer Information
        ? [Information] extends [never]
          ? UnknownCore
          : Information extends { t: infer Types extends string; a: infer Array extends boolean }
            ? [
                Canonical<Types>,
                Input[1] extends true ? (true extends Array ? false : true) : Input[1],
                never,
                false,
                never,
              ]
            : OpaqueCore
        : OpaqueCore

type FastApplyCall<Input extends CoreState, Name extends string, Args extends CoreState[]> = Input[0] extends 'opaque'
  ? OpaqueCore
  : Name extends 'select'
    ? Args extends [infer Projection extends CoreState, ...CoreState[]]
      ? FastSetSingle<Projection, BothSingle<Input[1], Projection[1]>>
      : OpaqueCore
    : Name extends 'ofType' | 'as'
      ? Args extends [infer Argument extends CoreState, ...CoreState[]]
        ? NormalizeTarget<Argument[4]> extends infer Target
          ? [Target] extends [never]
            ? OpaqueCore
            : Target extends keyof R4TypeOf & string
              ? FastNarrow<Input, Target>
              : OpaqueCore
          : OpaqueCore
        : OpaqueCore
      : Name extends keyof TypeFunctionRules
        ? FastApplyResultRule<TypeFunctionRules[Name], Input>
        : OpaqueCore

type FastApplyResultRule<Rule, Input extends CoreState> = Rule extends readonly [
  'fixed',
  infer Type extends string,
  infer Single extends Cardinality,
]
  ? [Canonical<Type>, Single, never, false, never]
  : Rule extends readonly ['input']
    ? Input
    : Rule extends readonly ['input-item']
      ? FastSetSingle<Input, true>
      : Rule extends readonly ['reference-targets']
        ? [Input[2]] extends [never]
          ? UnknownCore
          : [Input[2], Input[1], never, false, never]
        : Rule extends readonly ['unknown']
          ? UnknownCore
          : OpaqueCore

type FastNarrow<Input extends CoreState, Target extends string> = [Input[0]] extends [never]
  ? EmptyCore
  : Input[0] extends 'opaque'
    ? OpaqueCore
    : Input[0] extends 'unknown'
      ? UnknownCore
      : NarrowCandidates<Input[0], Normalize<Target>> extends infer Survivors extends string
        ? [Survivors] extends [never]
          ? OpaqueCore
          : [Survivors, true, never, false, never]
        : OpaqueCore

type FastSetSingle<State extends CoreState, Single extends Cardinality> = [
  State[0],
  Single,
  State[2],
  State[3],
  State[4],
]

type FastCallResult<State extends CoreState> = State[0] extends 'unknown' | 'opaque' ? FastMiss : State

type FastArgumentShape<Argument extends string> = Argument extends `'${infer Left}', '${infer Right}'`
  ? PlainStringContent<Left> extends true
    ? PlainStringContent<Right>
    : false
  : Argument extends `'${infer Content}'`
    ? PlainStringContent<Content>
    : Argument extends Digit | `${Digit}, ${Digit}`
      ? true
      : Argument extends `${infer Field} = '${infer Value}'`
        ? IdentifierText<Field> extends true
          ? PlainStringContent<Value>
          : false
        : false

type PlainStringContent<Content extends string> = Content extends `${string}'${string}` ? false : true

type IdentifierText<Text extends string> = Text extends `${infer Character}${infer Rest}`
  ? Character extends Letter
    ? IdentifierTail<Rest>
    : false
  : false

type IdentifierTail<Text extends string> = Text extends ''
  ? true
  : Text extends `${infer Character}${infer Rest}`
    ? Character extends IdentifierPart
      ? IdentifierTail<Rest>
      : false
    : false

type ShortSafeArgument<
  Argument extends string,
  Seen extends unknown[] = [],
  Quoted extends boolean = false,
> = Argument extends ''
  ? Quoted extends false
    ? true
    : false
  : Seen['length'] extends 24
    ? false
    : Argument extends `${infer Character}${infer Rest}`
      ? Character extends "'"
        ? ShortSafeArgument<Rest, [...Seen, 0], Quoted extends true ? false : true>
        : Character extends '\\' | '`' | '(' | ')' | '[' | ']' | '{' | '}'
          ? false
          : ShortSafeArgument<Rest, [...Seen, 0], Quoted>
      : false

type ShortText<Text extends string, Limit extends number, Seen extends unknown[] = []> = Text extends ''
  ? true
  : Seen['length'] extends Limit
    ? false
    : Text extends `${infer _Character}${infer Rest}`
      ? ShortText<Rest, Limit, [...Seen, 0]>
      : false

/** Exposed only for compile-time tokenizer boundary and parity tests. */
export type TokenizationStatus<Expression extends string> =
  Tokenize<Expression> extends TypeTokens ? Tokenize<Expression>['length'] : 'opaque'

type ParseLoop<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
  Mode extends ParseMode,
> = Mode extends 'operand'
  ? ParseOperand<Tokens, Stack, Ops, Delimiters, Context>
  : Mode extends 'member'
    ? ParseMember<Tokens, Stack, Ops, Delimiters, Context>
    : ParseOperator<Tokens, Stack, Ops, Delimiters, Context>

type ParseOperand<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = Tokens extends []
  ? OpaqueState
  : Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
    ? Token extends ['name', infer Name extends string]
      ? Rest extends [['symbol', '('], ...infer AfterOpen extends TypeTokens]
        ? StartCall<AfterOpen, Stack, Ops, Delimiters, Context, Context, Name>
        : ParseLoop<Rest, [...Stack, NameState<Name, Context>], Ops, Delimiters, Context, 'operator'>
      : Token extends ['keyword', infer Word extends string]
        ? Word extends 'true' | 'false'
          ? ParseLoop<
              Rest,
              [...Stack, CopyEnvironment<['System.Boolean', true, never, false, Word], Context>],
              Ops,
              Delimiters,
              Context,
              'operator'
            >
          : Word extends 'as' | 'contains' | 'in' | 'is'
            ? Rest extends [['symbol', '('], ...infer AfterOpen extends TypeTokens]
              ? StartCall<AfterOpen, Stack, Ops, Delimiters, Context, Context, Word>
              : ParseLoop<Rest, [...Stack, NameState<Word, Context>], Ops, Delimiters, Context, 'operator'>
            : OpaqueState
        : Token extends ['number', infer Number extends string]
          ? ParseNumberOperand<Number, Rest, Stack, Ops, Delimiters, Context>
          : Token extends LiteralToken
            ? ParseLoop<
                Rest,
                [...Stack, CopyEnvironment<LiteralState<Token>, Context>],
                Ops,
                Delimiters,
                Context,
                'operator'
              >
            : Token extends ['special', infer Special extends 'this' | 'index' | 'total']
              ? ParseLoop<Rest, [...Stack, SpecialState<Special, Context>], Ops, Delimiters, Context, 'operator'>
              : Token extends ['symbol', '%']
                ? ParseExternal<Rest, Stack, Ops, Delimiters, Context>
                : Token extends ['symbol', '(']
                  ? ParseLoop<Rest, [], [], [['group', Stack, Ops, Context], ...Delimiters], Context, 'operand'>
                  : Token extends ['symbol', '{']
                    ? Rest extends [['symbol', '}'], ...infer AfterEmpty extends TypeTokens]
                      ? ParseLoop<
                          AfterEmpty,
                          [...Stack, CopyEnvironment<EmptyState, Context>],
                          Ops,
                          Delimiters,
                          Context,
                          'operator'
                        >
                      : OpaqueState
                    : Token extends ['symbol', infer Unary extends '+' | '-']
                      ? ParseLoop<
                          Rest,
                          Stack,
                          [...Ops, ['unary', Unary, PrefixBindingPower<Unary>]],
                          Delimiters,
                          Context,
                          'operand'
                        >
                      : Token extends ['symbol', ')']
                        ? CloseEmptyCall<Rest, Stack, Ops, Delimiters, Context>
                        : OpaqueState
    : OpaqueState

type ParseNumberOperand<
  NumberText extends string,
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = NumberText extends `${string}L`
  ? ContinueOperand<
      Tokens,
      [...Stack, CopyEnvironment<['System.Long', true, never, false, 'long'], Context>],
      Ops,
      Delimiters,
      Context
    >
  : Tokens extends [['string', string], ...infer Rest extends TypeTokens]
    ? ContinueOperand<
        Rest,
        [...Stack, CopyEnvironment<['System.Quantity', true, never, false, 'quantity'], Context>],
        Ops,
        Delimiters,
        Context
      >
    : Tokens extends [['name', infer Unit extends string], ...infer Rest extends TypeTokens]
      ? Unit extends CompactCalendarUnit
        ? ContinueOperand<
            Rest,
            [...Stack, CopyEnvironment<['System.Quantity', true, never, false, 'quantity'], Context>],
            Ops,
            Delimiters,
            Context
          >
        : ContinueNumber<NumberText, Tokens, Stack, Ops, Delimiters, Context>
      : ContinueNumber<NumberText, Tokens, Stack, Ops, Delimiters, Context>

type ContinueNumber<
  NumberText extends string,
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = ContinueOperand<
  Tokens,
  [
    ...Stack,
    CopyEnvironment<
      NumberText extends `${string}.${string}`
        ? ['System.Decimal', true, never, false, 'decimal']
        : ['System.Integer', true, never, false, 'integer'],
      Context
    >,
  ],
  Ops,
  Delimiters,
  Context
>

type ContinueOperand<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = ParseLoop<Tokens, Stack, Ops, Delimiters, Context, 'operator'>

type ParseExternal<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
  ? Token extends ['name' | 'string', infer Name extends string]
    ? ParseLoop<Rest, [...Stack, ExternalState<Name, Context>], Ops, Delimiters, Context, 'operator'>
    : OpaqueState
  : OpaqueState

type ParseMember<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = Stack extends [...infer Before extends Values, infer Focus extends InferenceState]
  ? Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
    ? Token extends ['name' | 'keyword', infer Name extends string]
      ? Name extends 'true' | 'false'
        ? OpaqueState
        : Rest extends [['symbol', '('], ...infer AfterOpen extends TypeTokens]
          ? StartCall<AfterOpen, Before, Ops, Delimiters, Context, Focus, Name>
          : ParseLoop<Rest, [...Before, MemberState<Focus, Name>], Ops, Delimiters, Context, 'operator'>
      : Token extends ['special', infer Special extends 'this' | 'index' | 'total']
        ? ParseLoop<Rest, [...Before, SpecialState<Special, Focus>], Ops, Delimiters, Context, 'operator'>
        : OpaqueState
    : OpaqueState
  : OpaqueState

type ParseOperator<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = Tokens extends []
  ? Delimiters extends []
    ? FinishRoot<Stack, Ops>
    : OpaqueState
  : Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
    ? Token extends ['symbol', '.']
      ? ParseletReducer<'.'> extends 'dot'
        ? ParseLoop<Rest, Stack, Ops, Delimiters, Context, 'member'>
        : OpaqueState
      : Token extends ['symbol', '[']
        ? ParseletReducer<'['> extends 'indexer'
          ? Stack extends [...Values, InferenceState]
            ? ParseLoop<Rest, [], [], [['index', Stack, Ops, Context, Last<Stack>], ...Delimiters], Context, 'operand'>
            : OpaqueState
          : OpaqueState
        : Token extends ['symbol', ']' | ')'] | ['symbol', ',']
          ? CloseDelimited<Token[1], Rest, Stack, Ops, Delimiters, Context>
          : Token extends ['symbol' | 'keyword', infer Operator extends string]
            ? Operator extends 'is' | 'as'
              ? ParseTypeOperator<Operator, Rest, Stack, Ops, Delimiters, Context>
              : Operator extends keyof TypeInfixParselets
                ? ParseletReducer<Operator> extends 'binary'
                  ? PushBinary<Operator, ParseletBindingPower<Operator>, Rest, Stack, Ops, Delimiters, Context>
                  : OpaqueState
                : OpaqueState
            : OpaqueState
    : OpaqueState

type StartCall<
  Tokens extends TypeTokens,
  OuterStack extends Values,
  OuterOps extends Operators,
  Delimiters extends Frames,
  OuterContext extends InferenceState,
  Focus extends InferenceState,
  Name extends string,
> =
  ParseletReducer<'('> extends 'call'
    ? ParseLoop<
        Tokens,
        [],
        [],
        [['call', OuterStack, OuterOps, OuterContext, Focus, Name, []], ...Delimiters],
        ArgumentContext<Name, 0, Focus, OuterContext>,
        'operand'
      >
    : OpaqueState

type CloseEmptyCall<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  _Context extends InferenceState,
> = Stack extends []
  ? Ops extends []
    ? Delimiters extends [
        [
          'call',
          infer OuterStack extends Values,
          infer OuterOps extends Operators,
          infer OuterContext extends InferenceState,
          infer Focus extends InferenceState,
          infer Name extends string,
          infer Args extends InferenceState[],
        ],
        ...infer OuterFrames extends Frames,
      ]
      ? Args extends []
        ? ParseLoop<
            Tokens,
            [...OuterStack, ApplyCall<Focus, Name, []>],
            OuterOps,
            OuterFrames,
            OuterContext,
            'operator'
          >
        : OpaqueState
      : OpaqueState
    : OpaqueState
  : OpaqueState

type CloseDelimited<
  Delimiter extends string,
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = Ops extends [...infer Remaining extends Operators, infer Top extends OperatorFrame]
  ? ReduceOne<Stack, Top> extends infer Reduced
    ? Reduced extends Values
      ? CloseDelimited<Delimiter, Tokens, Reduced, Remaining, Delimiters, Context>
      : OpaqueState
    : OpaqueState
  : Stack extends [infer Result extends InferenceState]
    ? ResumeDelimiter<Delimiter, Tokens, Result, Delimiters>
    : OpaqueState

type ResumeDelimiter<
  Delimiter extends string,
  Tokens extends TypeTokens,
  Result extends InferenceState,
  Delimiters extends Frames,
> = Delimiters extends [infer Frame extends DelimiterFrame, ...infer OuterFrames extends Frames]
  ? Frame extends [
      'group',
      infer OuterStack extends Values,
      infer OuterOps extends Operators,
      infer OuterContext extends InferenceState,
    ]
    ? Delimiter extends ')'
      ? ParseLoop<Tokens, [...OuterStack, Result], OuterOps, OuterFrames, OuterContext, 'operator'>
      : OpaqueState
    : Frame extends [
          'index',
          infer OuterStack extends Values,
          infer OuterOps extends Operators,
          infer OuterContext extends InferenceState,
          infer _Target extends InferenceState,
        ]
      ? Delimiter extends ']'
        ? ParseLoop<Tokens, IndexResult<OuterStack, Result>, OuterOps, OuterFrames, OuterContext, 'operator'>
        : OpaqueState
      : Frame extends [
            'call',
            infer OuterStack extends Values,
            infer OuterOps extends Operators,
            infer OuterContext extends InferenceState,
            infer Focus extends InferenceState,
            infer Name extends string,
            infer Args extends InferenceState[],
          ]
        ? Delimiter extends ','
          ? ParseLoop<
              Tokens,
              [],
              [],
              [['call', OuterStack, OuterOps, OuterContext, Focus, Name, [...Args, Result]], ...OuterFrames],
              ArgumentContext<Name, [...Args, Result]['length'], Focus, OuterContext>,
              'operand'
            >
          : Delimiter extends ')'
            ? ParseLoop<
                Tokens,
                [...OuterStack, ApplyCall<Focus, Name, [...Args, Result]>],
                OuterOps,
                OuterFrames,
                OuterContext,
                'operator'
              >
            : OpaqueState
        : OpaqueState
  : OpaqueState

type PushBinary<
  Operator extends string,
  BindingPower extends number,
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = Ops extends [...infer Remaining extends Operators, infer Top extends OperatorFrame]
  ? GreaterThanOrEqual<OperatorBindingPower<Top>, BindingPower> extends true
    ? ReduceOne<Stack, Top> extends infer Reduced
      ? Reduced extends Values
        ? PushBinary<Operator, BindingPower, Tokens, Reduced, Remaining, Delimiters, Context>
        : OpaqueState
      : OpaqueState
    : ParseLoop<Tokens, Stack, [...Ops, ['binary', Operator, BindingPower, Context]], Delimiters, Context, 'operand'>
  : ParseLoop<Tokens, Stack, [['binary', Operator, BindingPower, Context]], Delimiters, Context, 'operand'>

type FinishRoot<Stack extends Values, Ops extends Operators> = Ops extends [
  ...infer Remaining extends Operators,
  infer Top extends OperatorFrame,
]
  ? ReduceOne<Stack, Top> extends infer Reduced
    ? Reduced extends Values
      ? FinishRoot<Reduced, Remaining>
      : OpaqueState
    : OpaqueState
  : Stack extends [infer Result extends InferenceState]
    ? Result
    : OpaqueState

type ReduceOne<Stack extends Values, Operator extends OperatorFrame> = Operator extends UnaryOperatorFrame
  ? Stack extends [...infer Before extends Values, infer Operand extends InferenceState]
    ? [...Before, ApplyUnary<Operand>]
    : OpaqueState
  : Operator extends ['binary', infer Name extends string, number, infer Environment extends InferenceState]
    ? Stack extends [
        ...infer Before extends Values,
        infer Left extends InferenceState,
        infer Right extends InferenceState,
      ]
      ? [...Before, ApplyBinary<Name, Left, Right, Environment>]
      : OpaqueState
    : OpaqueState

type ApplyUnary<Operand extends InferenceState> = [Operand[0]] extends [never]
  ? Operand
  : IsOpaqueState<Operand> extends true
    ? CopyEnvironment<OpaqueState, Operand>
    : IsUnknownState<Operand> extends true
      ? CopyEnvironment<UnknownState, Operand>
      : [Operand[0]] extends [NumericType | QuantityType]
        ? Operand
        : CopyEnvironment<OpaqueState, Operand>

type ApplyBinary<
  Name extends string,
  Left extends InferenceState,
  Right extends InferenceState,
  Environment extends InferenceState,
> = Name extends keyof TypeOperatorRules
  ? CopyEnvironment<ApplyOperatorRule<TypeOperatorRules[Name], Name, Left, Right>, Environment>
  : CopyEnvironment<OpaqueState, Environment>

type ApplyOperatorRule<Rule, Name extends string, Left extends InferenceState, Right extends InferenceState> =
  IsOpaqueState<Left> extends true
    ? OpaqueState
    : IsOpaqueState<Right> extends true
      ? OpaqueState
      : Rule extends readonly ['fixed', infer Type extends string, infer Single extends boolean]
        ? [Canonical<Type>, Single, never, false, never]
        : Rule extends readonly ['arithmetic']
          ? ArithmeticState<Name, Left, Right>
          : Rule extends readonly ['union']
            ? UnionState<Left, Right>
            : OpaqueState

type ArithmeticState<
  Operator extends string,
  Left extends InferenceState,
  Right extends InferenceState,
> = Operator extends '*' | '/'
  ? IsQuantityState<Left> extends true
    ? ['System.Quantity', true, never, false, never]
    : IsQuantityState<Right> extends true
      ? ['System.Quantity', true, never, false, never]
      : Operator extends '/'
        ? ['System.Decimal', true, never, false, never]
        : ArithmeticInput<Left, Right>
  : ArithmeticInput<Left, Right>

type ArithmeticInput<Left extends InferenceState, Right extends InferenceState> = [Left[0]] extends [never]
  ? SetSingle<Left, true>
  : IsUnknownState<Left> extends true
    ? IsUnknownState<Right> extends true
      ? UnknownState
      : SetSingle<Right, true>
    : SetSingle<Left, true>

type IsQuantityState<State extends InferenceState> = [State[0]] extends [never]
  ? false
  : [State[0]] extends [QuantityType]
    ? true
    : false

type ParseTypeOperator<
  Operator extends 'is' | 'as',
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> =
  ConsumeTypeName<Tokens> extends [infer TypeName extends string, infer Rest extends TypeTokens]
    ? NormalizeTarget<TypeName> extends infer Target
      ? [Target] extends [never]
        ? OpaqueState
        : Target extends keyof R4TypeOf & string
          ? ApplyTypeWithPrecedence<Operator, Target, Rest, Stack, Ops, Delimiters, Context>
          : OpaqueState
      : OpaqueState
    : OpaqueState

type ApplyTypeWithPrecedence<
  Operator extends 'is' | 'as',
  Target extends keyof R4TypeOf & string,
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = Ops extends [...infer Remaining extends Operators, infer Top extends OperatorFrame]
  ? GreaterThanOrEqual<OperatorBindingPower<Top>, ParseletBindingPower<Operator>> extends true
    ? ReduceOne<Stack, Top> extends infer Reduced
      ? Reduced extends Values
        ? ApplyTypeWithPrecedence<Operator, Target, Tokens, Reduced, Remaining, Delimiters, Context>
        : OpaqueState
      : OpaqueState
    : ApplyTypeResult<Operator, Target, Tokens, Stack, Ops, Delimiters, Context>
  : ApplyTypeResult<Operator, Target, Tokens, Stack, Ops, Delimiters, Context>

type ApplyTypeResult<
  Operator extends 'is' | 'as',
  Target extends keyof R4TypeOf & string,
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
> = Stack extends [...infer Before extends Values, infer Operand extends InferenceState]
  ? ParseLoop<
      Tokens,
      [...Before, ApplyTypeOperator<TypeTypeOperatorRules[Operator], Operand, Target>],
      Ops,
      Delimiters,
      Context,
      'operator'
    >
  : OpaqueState

type ApplyTypeOperator<Rule, Operand extends InferenceState, Target extends string> =
  IsOpaqueState<Operand> extends true
    ? CopyEnvironment<OpaqueState, Operand>
    : Rule extends readonly ['fixed', infer Type extends string, infer Single extends boolean]
      ? CopyEnvironment<[Canonical<Type>, Single, never, false, never], Operand>
      : Rule extends readonly ['narrow']
        ? Narrow<Operand, Target>
        : CopyEnvironment<OpaqueState, Operand>

type ConsumeTypeName<Tokens extends TypeTokens> = Tokens extends [
  ['name', infer First extends string],
  ...infer Rest extends TypeTokens,
]
  ? ConsumeTypeNameTail<Rest, First>
  : never

type ConsumeTypeNameTail<Tokens extends TypeTokens, Acc extends string> = Tokens extends [
  ['symbol', '.'],
  ['name', infer Part extends string],
  ...infer Rest extends TypeTokens,
]
  ? ConsumeTypeNameTail<Rest, `${Acc}.${Part}`>
  : [Acc, Tokens]

type NormalizeTarget<Target extends string> = Target extends `FHIR.${infer Local}`
  ? Local extends keyof R4TypeOf
    ? Local
    : never
  : Target extends keyof R4TypeOf
    ? Target
    : `System.${Target}` extends keyof R4TypeOf
      ? `System.${Target}`
      : never

type ApplyCall<Input extends InferenceState, Name extends string, Args extends InferenceState[]> =
  IsOpaqueState<Input> extends true
    ? CopyEnvironment<OpaqueState, Input>
    : Name extends 'ofType' | 'as'
      ? Args extends [infer Argument extends InferenceState, ...InferenceState[]]
        ? NormalizeTarget<Argument[4]> extends infer Target
          ? [Target] extends [never]
            ? CopyEnvironment<OpaqueState, Input>
            : Target extends keyof R4TypeOf & string
              ? Narrow<Input, Target>
              : CopyEnvironment<OpaqueState, Input>
          : CopyEnvironment<OpaqueState, Input>
        : CopyEnvironment<OpaqueState, Input>
      : Name extends keyof TypeFunctionRules
        ? ApplyFunctionEffect<Name, ApplyResultRule<TypeFunctionRules[Name], Input, Args>, Input, Args>
        : CopyEnvironment<OpaqueState, Input>

type ApplyFunctionEffect<
  Name extends string,
  Result extends InferenceState,
  Input extends InferenceState,
  Args extends InferenceState[],
> = Name extends 'defineVariable'
  ? Args extends [infer NameArgument extends InferenceState, ...InferenceState[]]
    ? [NameArgument[4]] extends [never]
      ? Result
      : BindVariable<Result, NameArgument[4], Args[1] extends InferenceState ? Args[1] : Input>
    : Result
  : Result

type ApplyResultRule<Rule, Input extends InferenceState, Args extends InferenceState[]> = Rule extends {
  readonly 0: 'fixed'
  readonly 1: infer Type extends string
  readonly 2: infer Single extends Cardinality
}
  ? CopyEnvironment<[Canonical<Type>, Single, never, false, never], Input>
  : Rule extends readonly ['input']
    ? Input
    : Rule extends readonly ['input-item']
      ? SetSingle<Input, true>
      : Rule extends readonly [
            'argument',
            infer Index extends number,
            infer CardinalityRule extends 'argument' | 'input-and-argument',
          ]
        ? ArgumentState<Args, Index> extends infer Argument extends InferenceState
          ? CardinalityRule extends 'input-and-argument'
            ? SetSingle<CopyEnvironment<Argument, Input>, BothSingle<Input[1], Argument[1]>>
            : CopyEnvironment<Argument, Input>
          : CopyEnvironment<UnknownState, Input>
        : Rule extends readonly ['union', infer Sources extends 'input' | number, infer Single extends boolean | 'all']
          ? CombineRuleSources<Sources, Input, Args> extends infer Combined extends InferenceState
            ? SetSingle<CopyEnvironment<Combined, Input>, Single extends 'all' ? Combined[1] : Extract<Single, boolean>>
            : CopyEnvironment<UnknownState, Input>
          : Rule extends readonly ['arguments-union']
            ? CopyEnvironment<UnionArguments<Args>, Input>
            : Rule extends readonly ['reference-targets']
              ? [Input[2]] extends [never]
                ? CopyEnvironment<UnknownState, Input>
                : CopyEnvironment<[Input[2], Input[1], never, false, never], Input>
              : Rule extends readonly ['unknown']
                ? CopyEnvironment<UnknownState, Input>
                : CopyEnvironment<OpaqueState, Input>

type ArgumentState<Args extends InferenceState[], Index extends number> = Args[Index] extends InferenceState
  ? Args[Index]
  : UnknownState

type CombineRuleSources<
  Sources extends 'input' | number,
  Input extends InferenceState,
  Args extends InferenceState[],
> = CollapseStateUnion<
  Sources extends Sources
    ? Sources extends 'input'
      ? Input
      : SourceArgumentState<Args, Extract<Sources, number>>
    : never
>

type SourceArgumentState<Args extends InferenceState[], Index extends number> = Args[Index] extends InferenceState
  ? Args[Index]
  : EmptyState

type CollapseStateUnion<States extends InferenceState> = 'opaque' extends States[0]
  ? OpaqueState
  : 'unknown' extends States[0]
    ? UnknownState
    : CopyEnvironment<[States[0], AllSingle<States[1]>, never, false, never], States>

type AllSingle<Single extends Cardinality> = false extends Single ? false : 'unknown' extends Single ? 'unknown' : true

type UnionArguments<Args extends InferenceState[], Accumulator extends InferenceState = EmptyState> = Args extends [
  infer Head extends InferenceState,
  ...infer Tail extends InferenceState[],
]
  ? UnionArguments<Tail, MergeStates<Accumulator, Head>>
  : Accumulator

type MergeStates<Left extends InferenceState, Right extends InferenceState> = [Left[0]] extends [never]
  ? Right
  : [Right[0]] extends [never]
    ? Left
    : IsOpaqueState<Left> extends true
      ? OpaqueState
      : IsOpaqueState<Right> extends true
        ? OpaqueState
        : IsUnknownState<Left> extends true
          ? UnknownState
          : IsUnknownState<Right> extends true
            ? UnknownState
            : CopyEnvironment<
                [Left[0] | Right[0], BothSingle<Left[1], Right[1]>, CommonTargets<Left, Right>, false, never],
                Left
              >

type CommonTargets<Left extends InferenceState, Right extends InferenceState> = [Left[2]] extends [never]
  ? never
  : [Right[2]] extends [never]
    ? never
    : Left[2] | Right[2]

type BindVariable<Result extends InferenceState, Name extends string, Value extends InferenceState> =
  BindingsOf<Result> extends 'opaque'
    ? Result
    : Name extends 'context' | 'resource' | 'rootResource' | 'ucum' | 'sct' | 'loinc'
      ? CopyEnvironment<OpaqueCore, Result>
      : LookupBinding<BindingsOf<Result>, Name> extends never
        ? CoreOf<Result> &
            EnvironmentCarrier<
              [
                [...BindingsOf<Result>, [Name, CoreOf<Value>]],
                RootTypesOf<Result>,
                RootSingleOf<Result>,
                RootTargetsOf<Result>,
              ]
            >
        : CopyEnvironment<OpaqueCore, Result>

type LookupBinding<Bindings extends BindingState, Name extends string> = Bindings extends VariableBindings
  ? Bindings extends [...infer Before extends VariableBindings, infer LastBinding extends VariableBinding]
    ? LastBinding[0] extends Name
      ? LastBinding[1]
      : LookupBinding<Before, Name>
    : never
  : never

type NameState<Name extends string, Context extends InferenceState> = Name extends keyof R4Resources & string
  ? CopyEnvironment<[Name, true, never, false, Name], Context>
  : SetAtom<Navigate<Context, Name>, Name>

type SpecialState<Name extends 'this' | 'index' | 'total', Context extends InferenceState> = Name extends 'this'
  ? SetSingle<Context, true>
  : Name extends 'index'
    ? CopyEnvironment<['System.Integer', true, never, false, 'integer'], Context>
    : CopyEnvironment<UnknownState, Context>

type ExternalState<Name extends string, Context extends InferenceState> =
  LookupBinding<BindingsOf<Context>, Name> extends infer Found
    ? [Found] extends [never]
      ? Name extends 'context' | 'resource' | 'rootResource'
        ? CopyEnvironment<
            [RootTypesOf<Context>, RootSingleOf<Context>, RootTargetsOf<Context>, false, `%${Name}`],
            Context
          >
        : Name extends 'ucum' | 'sct' | 'loinc' | `vs-${string}` | `ext-${string}`
          ? CopyEnvironment<['System.String', true, never, false, `%${Name}`], Context>
          : CopyEnvironment<['unknown', 'unknown', never, false, `%${Name}`], Context>
      : Found extends CoreState
        ? CopyEnvironment<Found, Context>
        : CopyEnvironment<UnknownState, Context>
    : CopyEnvironment<UnknownState, Context>

type MemberState<Focus extends InferenceState, Name extends string> = [Focus[4]] extends [never]
  ? Navigate<Focus, Name>
  : Focus[4] extends 'FHIR' | 'System'
    ? CopyEnvironment<['unknown', 'unknown', never, false, `${Focus[4]}.${Name}`], Focus>
    : Navigate<Focus, Name>

type ArgumentContext<
  Name extends string,
  Index extends number,
  Focus extends InferenceState,
  OuterContext extends InferenceState,
> =
  ArgumentSpecAt<Name, Index> extends 'expression' | 'condition' | 'sort-key'
    ? Focus
    : CopyEnvironment<OuterContext, Focus>

type ArgumentSpecAt<Name extends string, Index extends number> = Index extends 0
  ? Name extends CompactLambdaArgument0Name
    ? 'expression'
    : 'eager'
  : Index extends 1
    ? Name extends CompactLambdaArgument1Name
      ? 'expression'
      : 'eager'
    : Name extends CompactLambdaArgument2Name
      ? 'expression'
      : 'eager'

type InputState<Input extends string, TrackEnvironment extends boolean, BindingFallback extends boolean> =
  Normalize<Input> extends infer Name extends string
    ? Name extends keyof R4TypeOf
      ? BindingFallback extends true
        ? [Name, true, never, true, never] & EnvironmentCarrier<['opaque', Name, true, never]>
        : TrackEnvironment extends true
          ? [Name, true, never, true, never] & EnvironmentCarrier<[[], Name, true, never]>
          : [Name, true, never, true, never]
      : BindingFallback extends true
        ? UnknownCore & EnvironmentCarrier<['opaque', 'unknown', 'unknown', never]>
        : TrackEnvironment extends true
          ? UnknownCore & EnvironmentCarrier<DefaultEnvironment>
          : UnknownCore
    : BindingFallback extends true
      ? UnknownCore & EnvironmentCarrier<['opaque', 'unknown', 'unknown', never]>
      : TrackEnvironment extends true
        ? UnknownCore & EnvironmentCarrier<DefaultEnvironment>
        : UnknownCore

type FastInputState<Input extends string> =
  Normalize<Input> extends infer Name extends string
    ? Name extends keyof R4TypeOf
      ? [Name, true, never, true, never]
      : UnknownCore
    : UnknownCore

type Navigate<Input extends InferenceState, Element extends string> = [Input[0]] extends [never]
  ? CopyEnvironment<EmptyState, Input>
  : IsOpaqueState<Input> extends true
    ? CopyEnvironment<OpaqueState, Input>
    : IsUnknownState<Input> extends true
      ? CopyEnvironment<UnknownState, Input>
      : ElementInformation<Input[0], Element> extends infer Information
        ? [Information] extends [never]
          ? CopyEnvironment<UnknownState, Input>
          : Information extends { t: infer Types extends string; a: infer Array extends boolean }
            ? CopyEnvironment<
                [
                  Canonical<Types>,
                  Input[1] extends true ? (true extends Array ? false : true) : Input[1],
                  ReferenceTargets<Input[0], Element, Types>,
                  false,
                  never,
                ],
                Input
              >
            : CopyEnvironment<OpaqueState, Input>
        : CopyEnvironment<OpaqueState, Input>

type ReferenceTargets<
  InputTypes extends string,
  Element extends string,
  Types extends string,
> = 'Reference' extends Types
  ? ReferenceTargetInformation<InputTypes, Element> extends infer Targets extends string
    ? 'unknown' extends Targets
      ? never
      : Targets
    : never
  : never

type ReferenceTargetInformation<Type extends string, Element extends string> = Type extends Type
  ? ReferenceTargetInfo<Type, Element>
  : never

type ReferenceTargetInfo<Type extends string, Element extends string> = Type extends keyof R4ReferenceTargets
  ? Element extends keyof R4ReferenceTargets[Type]
    ? Extract<R4ReferenceTargets[Type][Element], string>
    : Type extends keyof R4Bases
      ? R4Bases[Type] extends string
        ? ReferenceTargetInfo<R4Bases[Type], Element>
        : never
      : never
  : Type extends keyof R4Bases
    ? R4Bases[Type] extends string
      ? ReferenceTargetInfo<R4Bases[Type], Element>
      : never
    : never

type ElementInformation<Type extends string, Element extends string> = Type extends Type
  ? ElementInfo<Type, Element>
  : never

type ElementInfo<Type extends string, Element extends string> = Type extends keyof R4Elements
  ? Element extends keyof R4Elements[Type]
    ? R4Elements[Type][Element]
    : Type extends keyof R4Bases
      ? R4Bases[Type] extends string
        ? ElementInfo<R4Bases[Type], Element>
        : never
      : never
  : Type extends 'System.Quantity'
    ? Element extends 'value'
      ? { t: 'System.Decimal'; a: false }
      : Element extends 'unit'
        ? { t: 'System.String'; a: false }
        : never
    : never

type Normalize<Type extends string> = Type extends `FHIR.${infer Local}` ? Local : Type
type Canonical<Type extends string> = Type extends `FHIR.${infer Local}` ? Local : Type

type Narrow<Input extends InferenceState, Target extends string> = [Input[0]] extends [never]
  ? CopyEnvironment<EmptyState, Input>
  : IsOpaqueState<Input> extends true
    ? CopyEnvironment<OpaqueState, Input>
    : IsUnknownState<Input> extends true
      ? CopyEnvironment<UnknownState, Input>
      : NarrowCandidates<Input[0], Normalize<Target>> extends infer Survivors extends string
        ? [Survivors] extends [never]
          ? CopyEnvironment<OpaqueState, Input>
          : CopyEnvironment<[Survivors, true, never, false, never], Input>
        : CopyEnvironment<OpaqueState, Input>

type NarrowCandidates<Candidates extends string, Target extends string> = Candidates extends Candidates
  ? IsSubtype<Candidates, Target> extends true
    ? Candidates
    : IsSubtype<Target, Candidates> extends true
      ? Target
      : never
  : never

type IsSubtype<Type extends string, Base extends string, Seen extends string = never> = Type extends Base
  ? true
  : Base extends `System.${string}`
    ? [PrimitiveSystem<Type>] extends [never]
      ? IsModelSubtype<Type, Base, Seen>
      : PrimitiveSystem<Type> extends Base
        ? true
        : IsModelSubtype<Type, Base, Seen>
    : IsModelSubtype<Type, Base, Seen>

type IsModelSubtype<Type extends string, Base extends string, Seen extends string> = Type extends Seen
  ? false
  : Type extends keyof R4Bases
    ? R4Bases[Type] extends string
      ? IsSubtype<R4Bases[Type], Base, Seen | Type>
      : false
    : false

type PrimitiveSystem<Type extends string> = Type extends 'boolean'
  ? 'System.Boolean'
  : Type extends 'integer' | 'positiveInt' | 'unsignedInt'
    ? 'System.Integer'
    : Type extends 'integer64'
      ? 'System.Long'
      : Type extends 'decimal'
        ? 'System.Decimal'
        : Type extends 'date'
          ? 'System.Date'
          : Type extends 'dateTime' | 'instant'
            ? 'System.DateTime'
            : Type extends 'time'
              ? 'System.Time'
              : Type extends
                    | 'string'
                    | 'code'
                    | 'id'
                    | 'markdown'
                    | 'uri'
                    | 'url'
                    | 'canonical'
                    | 'oid'
                    | 'uuid'
                    | 'base64Binary'
                    | 'xhtml'
                ? 'System.String'
                : never

type UnionState<Left extends InferenceState, Right extends InferenceState> = [Left[0]] extends [never]
  ? Right
  : [Right[0]] extends [never]
    ? Left
    : Left[0] extends 'opaque'
      ? OpaqueState
      : Right[0] extends 'opaque'
        ? OpaqueState
        : Left[0] extends 'unknown'
          ? UnknownState
          : Right[0] extends 'unknown'
            ? UnknownState
            : [Left[0] | Right[0], false, CommonTargets<Left, Right>, false, never]

type SetSingle<State extends InferenceState, Single extends Cardinality> = CopyEnvironment<
  [State[0], Single, State[2], State[3], State[4]],
  State
>

type SetAtom<State extends InferenceState, Atom extends string> = CopyEnvironment<
  [State[0], State[1], State[2], State[3], Atom],
  State
>

type BothSingle<Left extends Cardinality, Right extends Cardinality> = Left extends false
  ? false
  : Right extends false
    ? false
    : Left extends true
      ? Right
      : 'unknown'

type PublicResult<State extends CoreState> = [State[0]] extends [never]
  ? never[]
  : State[0] extends 'opaque'
    ? unknown[]
    : State[0] extends 'unknown'
      ? unknown[]
      : R4TypeOf[Extract<State[0], keyof R4TypeOf>][]

type LiteralState<Token extends LiteralToken> = Token[0] extends 'string'
  ? ['System.String', true, never, false, Token[1]]
  : Token[0] extends 'date'
    ? ['System.Date', true, never, false, Token[1]]
    : Token[0] extends 'dateTime'
      ? ['System.DateTime', true, never, false, Token[1]]
      : Token[0] extends 'time'
        ? ['System.Time', true, never, false, Token[1]]
        : UnknownState

type IndexResult<Stack extends Values, Index extends InferenceState> = Stack extends [
  ...infer Before extends Values,
  infer Target extends InferenceState,
]
  ? Index[4] extends 'integer'
    ? [...Before, Target]
    : [...Before, OpaqueState]
  : [OpaqueState]

/**
 * One binding is inferred through nested frames. Further definitions make
 * bindings opaque while result rules continue, which keeps TypeScript 5.8
 * below its conditional depth on the official 60-token nested-variable case.
 */
type TokenPolicy<
  Tokens extends TypeTokens,
  SeenDefinition extends boolean = false,
  NeedsEnvironment extends boolean = false,
> = Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
  ? Token extends UnsafeToken
    ? 'unsafe'
    : Token extends ['name', 'defineVariable']
      ? SeenDefinition extends true
        ? 'binding-fallback'
        : TokenPolicy<Rest, true, true>
      : Token extends ['symbol', '%']
        ? TokenPolicy<Rest, SeenDefinition, true>
        : TokenPolicy<Rest, SeenDefinition, NeedsEnvironment>
  : NeedsEnvironment extends true
    ? 'environment'
    : 'plain'

type Last<Stack extends Values> = Stack extends [...Values, infer Value extends InferenceState] ? Value : OpaqueState

type ParseletReducer<Token extends keyof TypeInfixParselets> = TypeInfixParselets[Token][5]
type ParseletBindingPower<Token extends keyof TypeInfixParselets> = TypeInfixParselets[Token][2]
type PrefixBindingPower<Token extends keyof TypePrefixParselets> = TypePrefixParselets[Token][2]
type OperatorBindingPower<Operator extends OperatorFrame> = Operator[2]

type NumericType =
  | 'System.Integer'
  | 'System.Long'
  | 'System.Decimal'
  | 'integer'
  | 'positiveInt'
  | 'unsignedInt'
  | 'integer64'
  | 'decimal'
type QuantityType = 'System.Quantity' | 'Quantity'

type GreaterThanOrEqual<
  Left extends number,
  Right extends number,
  Count extends unknown[] = [],
> = Count['length'] extends Right
  ? true
  : Count['length'] extends Left
    ? false
    : GreaterThanOrEqual<Left, Right, [...Count, 0]>
