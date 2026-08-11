import type { R4Bases, R4Elements, R4ReferenceTargets, R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'
import type { EmptyContextMap, LookupContextMap, MergeContextMaps } from './context-maps.ts'
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

type CoreState = [types: string, targets: string]
type VariableBinding = [name: string, value: CoreState]
type VariableBindings = VariableBinding[]
type BindingState = VariableBindings | 'opaque'
type InferenceEnvironment = [
  bindings: BindingState,
  rootTypes: string,
  rootTargets: string,
  host: object,
  activeHostDeclarations: string,
]
type DefaultEnvironment = [[], 'unknown', never, EmptyContextMap, never]
type EnvironmentCarrier<Environment extends InferenceEnvironment> = { readonly __environment: Environment }
type InferenceState = CoreState
type OpaqueCore = ['opaque', never]
type UnknownCore = ['unknown', never]
type EmptyCore = [never, never]
type OpaqueState = OpaqueCore
type UnknownState = UnknownCore
type EmptyState = EmptyCore
type CoreOf<State extends InferenceState> = [State[0], State[1]]
type EnvironmentOf<State extends InferenceState> =
  State extends EnvironmentCarrier<infer Environment> ? Environment : DefaultEnvironment
type BindingsOf<State extends InferenceState> = EnvironmentOf<State>[0]
type RootTypesOf<State extends InferenceState> = EnvironmentOf<State>[1]
type RootTargetsOf<State extends InferenceState> = EnvironmentOf<State>[2]
type HostContextOf<State extends InferenceState> = EnvironmentOf<State>[3]
type ActiveHostDeclarationsOf<State extends InferenceState> = EnvironmentOf<State>[4]
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
type IndexFrame = ['index', Values, Operators, InferenceState]
type CallFrame = ['call', Values, Operators, InferenceState, InferenceState, string, InferenceState[]]
type DefineVariableFrame = ['define-variable', Values, Operators, InferenceState, InferenceState, string]
type DelimiterFrame = GroupFrame | IndexFrame | CallFrame | DefineVariableFrame
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
export type InferTypeExpression<
  Expression extends string,
  Input extends string,
  Context extends object = EmptyContextMap,
> =
  HasHostContext<Context> extends true
    ? InferSlowExpression<Expression, Input, Context>
    : FastExpression<Expression, Input> extends infer Fast
      ? Fast extends CoreState
        ? PublicResult<Fast>
        : InferSlowExpression<Expression, Input, Context>
      : unknown[]

type InferSlowExpression<Expression extends string, Input extends string, Context extends object> =
  Tokenize<Expression> extends infer Tokens
    ? Tokens extends TypeTokens
      ? NeedsTokenPolicy<Expression> extends true
        ? TokenPolicy<Tokens> extends infer Policy
          ? Policy extends 'unsafe'
            ? unknown[]
            : Policy extends 'binding-fallback'
              ? InferParsed<Tokens, Input, Context, false, true>
              : InferParsed<Tokens, Input, Context, Policy extends 'environment' ? true : false>
          : unknown[]
        : InferParsed<Tokens, Input, Context, false>
      : unknown[]
    : unknown[]

type HasHostContext<Context extends object> = Context extends {
  env?: infer Env
  vars?: infer Vars
  functions?: infer Functions
}
  ? keyof Env | keyof Vars | keyof Functions extends never
    ? false
    : true
  : false

type NeedsTokenPolicy<Expression extends string> = Expression extends
  `${string}%${string}` | `${string}defineVariable${string}` | `${string}\\u${string}`
  ? true
  : false

type InferParsed<
  Tokens extends TypeTokens,
  Input extends string,
  HostContext extends object,
  TrackEnvironment extends boolean,
  BindingFallback extends boolean = false,
> =
  ParseLoop<
    Tokens,
    [],
    [],
    [],
    InputState<Input, HostContext, TrackEnvironment, BindingFallback>,
    'operand'
  > extends infer Result
    ? Result extends InferenceState
      ? PublicResult<Result>
      : unknown[]
    : unknown[]

/**
 * Model-known chains use a bounded shortcut. Four unrestricted steps may be
 * followed by two zero-argument calls. Anything with general argument syntax,
 * operators, trivia, or unknown names takes the tokenizer and stack parser.
 */
type FastExpression<Expression extends string, Input extends string> = Expression extends `${infer Root}.${infer Rest}`
  ? Root extends keyof R4Resources & string
    ? FastChain<Rest, [Root, never], []>
    : FastInputChain<Expression, Input>
  : Expression extends keyof R4Resources & string
    ? [Expression, never]
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
      ? FastCallResult<ApplyCall<State, Name, []>>
      : FastMiss
    : Segment extends `${infer Name}(${infer Argument})`
      ? Name extends 'ofType' | 'as'
        ? Argument extends keyof R4TypeOf & string
          ? ShortText<Argument, 32> extends true
            ? FastCallResult<Narrow<State, Argument>>
            : FastMiss
          : FastMiss
        : Name extends 'select'
          ? IdentifierText<Argument> extends true
            ? FastNavigate<State, Argument> extends infer Projection
              ? Projection extends CoreState
                ? FastCallResult<ApplyCall<State, Name, [Projection]>>
                : FastMiss
              : FastMiss
            : FastMiss
          : Name extends FastFunctionName
            ? FastArgumentShape<Argument> extends true
              ? ShortSafeArgument<Argument> extends true
                ? FastCallResult<ApplyCall<State, Name, [UnknownCore]>>
                : FastMiss
              : FastMiss
            : FastMiss
      : FastNavigate<State, Segment>

type FastNavigate<State extends CoreState, Name extends string> =
  Navigate<State, Name> extends infer Result
    ? Result extends CoreState
      ? Result[0] extends 'unknown' | 'opaque'
        ? FastMiss
        : Result
      : FastMiss
    : FastMiss

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

type IdentifierText<Text extends string> =
  ShortText<Text, 64> extends true
    ? Text extends `${infer Character}${infer Rest}`
      ? Character extends Letter
        ? IdentifierTail<Rest>
        : false
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

/** Exposed only for generated compile-time parity checks. */
export type FastSlowInferenceParity<Expression extends string, Input extends string> =
  FastExpression<Expression, Input> extends infer Fast
    ? Fast extends CoreState
      ? EqualTypes<PublicResult<Fast>, InferSlowExpression<Expression, Input, EmptyContextMap>>
      : true
    : true

type EqualTypes<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? (<Type>() => Type extends Right ? 1 : 2) extends <Type>() => Type extends Left ? 1 : 2
      ? true
      : false
    : false

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
              [...Stack, CopyEnvironment<['System.Boolean', never], Context>],
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
  ? ContinueOperand<Tokens, [...Stack, CopyEnvironment<['System.Long', never], Context>], Ops, Delimiters, Context>
  : Tokens extends [['string', string], ...infer Rest extends TypeTokens]
    ? ContinueOperand<Rest, [...Stack, CopyEnvironment<['System.Quantity', never], Context>], Ops, Delimiters, Context>
    : Tokens extends [['name', infer Unit extends string], ...infer Rest extends TypeTokens]
      ? Unit extends CompactCalendarUnit
        ? ContinueOperand<
            Rest,
            [...Stack, CopyEnvironment<['System.Quantity', never], Context>],
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
      NumberText extends `${string}.${string}` ? ['System.Decimal', never] : ['System.Integer', never],
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
            ? ParseLoop<Rest, [], [], [['index', Stack, Ops, Context], ...Delimiters], Context, 'operand'>
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
    ? Name extends 'ofType' | 'as'
      ? StartTypeFunctionCall<Tokens, OuterStack, OuterOps, Delimiters, OuterContext, Focus>
      : Name extends 'defineVariable'
        ? StartDefineVariableCall<Tokens, OuterStack, OuterOps, Delimiters, OuterContext, Focus>
        : ParseLoop<
            Tokens,
            [],
            [],
            [['call', OuterStack, OuterOps, OuterContext, Focus, Name, []], ...Delimiters],
            ArgumentContext<Name, 0, Focus, OuterContext>,
            'operand'
          >
    : OpaqueState

type StartTypeFunctionCall<
  Tokens extends TypeTokens,
  OuterStack extends Values,
  OuterOps extends Operators,
  Delimiters extends Frames,
  OuterContext extends InferenceState,
  Focus extends InferenceState,
> =
  ConsumeTypeName<Tokens> extends [infer TypeName extends string, infer Rest extends TypeTokens]
    ? Rest extends [['symbol', ')'], ...infer AfterClose extends TypeTokens]
      ? NormalizeTarget<TypeName> extends infer Target
        ? [Target] extends [never]
          ? OpaqueState
          : Target extends keyof R4TypeOf & string
            ? ParseLoop<
                AfterClose,
                [...OuterStack, Narrow<Focus, Target>],
                OuterOps,
                Delimiters,
                OuterContext,
                'operator'
              >
            : OpaqueState
        : OpaqueState
      : OpaqueState
    : OpaqueState

type StartDefineVariableCall<
  Tokens extends TypeTokens,
  OuterStack extends Values,
  OuterOps extends Operators,
  Delimiters extends Frames,
  OuterContext extends InferenceState,
  Focus extends InferenceState,
> = Tokens extends [['string', infer Name extends string], ...infer Rest extends TypeTokens]
  ? Rest extends [['symbol', ')'], ...infer AfterClose extends TypeTokens]
    ? ParseLoop<
        AfterClose,
        [...OuterStack, ApplyDefineVariable<Focus, Name, Focus>],
        OuterOps,
        Delimiters,
        OuterContext,
        'operator'
      >
    : Rest extends [['symbol', ','], ...infer AfterComma extends TypeTokens]
      ? ParseLoop<
          AfterComma,
          [],
          [],
          [['define-variable', OuterStack, OuterOps, OuterContext, Focus, Name], ...Delimiters],
          ArgumentContext<'defineVariable', 1, Focus, OuterContext>,
          'operand'
        >
      : OpaqueState
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
        : Frame extends [
              'define-variable',
              infer OuterStack extends Values,
              infer OuterOps extends Operators,
              infer OuterContext extends InferenceState,
              infer Focus extends InferenceState,
              infer Name extends string,
            ]
          ? Delimiter extends ')'
            ? ParseLoop<
                Tokens,
                [...OuterStack, ApplyDefineVariable<Focus, Name, Result>],
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
      : Rule extends readonly ['fixed', infer Type extends string, unknown]
        ? [Canonical<Type>, never]
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
    ? ['System.Quantity', never]
    : IsQuantityState<Right> extends true
      ? ['System.Quantity', never]
      : Operator extends '/'
        ? ['System.Decimal', never]
        : ArithmeticInput<Left, Right>
  : ArithmeticInput<Left, Right>

type ArithmeticInput<Left extends InferenceState, Right extends InferenceState> = [Left[0]] extends [never]
  ? Left
  : IsUnknownState<Left> extends true
    ? IsUnknownState<Right> extends true
      ? UnknownState
      : Right
    : Left

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
    : Rule extends readonly ['fixed', infer Type extends string, unknown]
      ? CopyEnvironment<[Canonical<Type>, never], Operand>
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
    : Name extends keyof TypeFunctionRules
      ? ApplyResultRule<TypeFunctionRules[Name], Input, Args>
      : HostFunctionState<Input, Name>

type HostFunctionState<Input extends InferenceState, Name extends string> =
  LookupContextMap<FunctionsOf<HostContextOf<Input>>, Name> extends infer Declaration
    ? [Declaration] extends [never]
      ? CopyEnvironment<OpaqueState, Input>
      : Name extends ActiveHostDeclarationsOf<Input>
        ? CopyEnvironment<UnknownState, Input>
        : Declaration extends { readonly overloads: infer Overloads extends readonly unknown[] }
          ? InferHostOverloads<Overloads, Input, Name>
          : InferHostDeclaration<Declaration, Input, Name>
    : CopyEnvironment<OpaqueState, Input>

type InferHostOverloads<Overloads extends readonly unknown[], Input extends InferenceState, Name extends string> =
  MatchingHostOverloads<Overloads, Input> extends infer Matching extends readonly unknown[]
    ? Matching extends readonly [infer Only]
      ? InferHostDeclaration<Only, Input, Name>
      : Matching extends readonly []
        ? CopyEnvironment<UnknownState, Input>
        : InferAmbiguousHostOverloads<Matching, Input>
    : CopyEnvironment<UnknownState, Input>

type MatchingHostOverloads<
  Overloads extends readonly unknown[],
  Input extends InferenceState,
  Matching extends readonly unknown[] = [],
> = Overloads extends readonly [infer Head, ...infer Tail]
  ? HostDeclarationAccepts<Head, Input> extends true
    ? MatchingHostOverloads<Tail, Input, [...Matching, Head]>
    : MatchingHostOverloads<Tail, Input, Matching>
  : Matching

type InferAmbiguousHostOverloads<
  Declarations extends readonly unknown[],
  Input extends InferenceState,
  Result extends InferenceState = EmptyState,
> = Declarations extends readonly [infer Head, ...infer Tail]
  ? InferAmbiguousHostOverloads<Tail, Input, MergeStates<Result, AmbiguousHostResult<Head, Input>>>
  : [Result[0]] extends [never]
    ? CopyEnvironment<UnknownState, Input>
    : CopyEnvironment<Result, Input>

type AmbiguousHostResult<Declaration, Input extends InferenceState> = Declaration extends {
  readonly signature?: infer Signature
}
  ? Signature extends { readonly result?: infer Result }
    ? Result extends { readonly types?: infer Types }
      ? Types extends readonly string[]
        ? HostSignatureResult<Types[number], Input>
        : CopyEnvironment<UnknownState, Input>
      : CopyEnvironment<UnknownState, Input>
    : CopyEnvironment<UnknownState, Input>
  : CopyEnvironment<UnknownState, Input>

type HostDeclarationAccepts<Declaration, Input extends InferenceState> = Declaration extends {
  readonly signature?: infer Signature
}
  ? Signature extends { readonly input?: infer InputSpec }
    ? InputSpec extends { readonly types?: infer Declared }
      ? Declared extends readonly string[]
        ? IsUnknownState<Input> extends true
          ? true
          : TypesOverlap<Input[0], Declared[number]>
        : true
      : true
    : true
  : true

type TypesOverlap<Left extends string, Right extends string> = true extends (
  Left extends Left
    ? Right extends Right
      ? IsSubtype<Normalize<Left>, Normalize<Right>> extends true
        ? true
        : IsSubtype<Normalize<Right>, Normalize<Left>>
      : never
    : never
)
  ? true
  : false

type InferHostDeclaration<Declaration, Input extends InferenceState, Name extends string> = Declaration extends {
  readonly criteria?: true
}
  ? CopyEnvironment<['System.Boolean', never], Input>
  : Declaration extends { readonly signature?: infer Signature }
    ? Signature extends { readonly result?: infer Result }
      ? Result extends { readonly types?: infer Types }
        ? Types extends readonly string[]
          ? HostSignatureResult<Types[number], Input>
          : InferHostBody<Declaration, Input, Name>
        : InferHostBody<Declaration, Input, Name>
      : InferHostBody<Declaration, Input, Name>
    : InferHostBody<Declaration, Input, Name>

type HostSignatureResult<Types extends string, Input extends InferenceState> = [Types] extends [never]
  ? CopyEnvironment<EmptyState, Input>
  : WideTypeName<Types> extends true
    ? CopyEnvironment<UnknownState, Input>
    : Canonical<Types> extends keyof R4TypeOf
      ? CopyEnvironment<[Canonical<Types>, never], Input>
      : CopyEnvironment<UnknownState, Input>

type InferHostBody<Declaration, Input extends InferenceState, Name extends string> =
  HostBodySource<Declaration> extends infer Body
    ? Body extends string
      ? string extends Body
        ? CopyEnvironment<UnknownState, Input>
        : InferEmbeddedState<
              Body,
              WithHostCallEnvironment<Input, Declaration, ActiveHostDeclarationsOf<Input> | Name>
            > extends infer Result
          ? Result extends InferenceState
            ? CopyEnvironment<Result, Input>
            : CopyEnvironment<UnknownState, Input>
          : CopyEnvironment<UnknownState, Input>
      : CopyEnvironment<UnknownState, Input>
    : CopyEnvironment<UnknownState, Input>

type HostBodySource<Declaration> = Declaration extends { readonly expression: infer Body }
  ? Body extends string
    ? Body
    : Body extends { readonly source: infer Source extends string }
      ? Source
      : never
  : never

type WithHostCallEnvironment<Input extends InferenceState, Declaration, Active extends string> = CoreOf<Input> &
  EnvironmentCarrier<
    [
      BindingsOf<Input>,
      RootTypesOf<Input>,
      RootTargetsOf<Input>,
      OverlayFunctionContext<HostContextOf<Input>, Declaration>,
      Active,
    ]
  >

type OverlayFunctionContext<Context extends object, Declaration> = {
  env: MergeContextMaps<
    EnvOf<Context>,
    Declaration extends { readonly envTypes?: infer Local } ? Local : EmptyContextMap
  >
  vars: VarsOf<Context>
  functions: FunctionsOf<Context>
}

type ApplyDefineVariable<
  Input extends InferenceState,
  Name extends string,
  Value extends InferenceState,
> = BindVariable<ApplyResultRule<TypeFunctionRules['defineVariable'], Input, []>, Name, Value>

type ApplyResultRule<Rule, Input extends InferenceState, Args extends InferenceState[]> = Rule extends {
  readonly 0: 'fixed'
  readonly 1: infer Type extends string
  readonly 2: unknown
}
  ? CopyEnvironment<[Canonical<Type>, never], Input>
  : Rule extends readonly ['input']
    ? Input
    : Rule extends readonly ['input-item']
      ? Input
      : Rule extends readonly ['argument', infer Index extends number, 'argument' | 'input-and-argument']
        ? ArgumentState<Args, Index> extends infer Argument extends InferenceState
          ? CopyEnvironment<Argument, Input>
          : CopyEnvironment<UnknownState, Input>
        : Rule extends readonly ['union', infer Sources extends 'input' | number, boolean | 'all']
          ? CombineRuleSources<Sources, Input, Args> extends infer Combined extends InferenceState
            ? CopyEnvironment<Combined, Input>
            : CopyEnvironment<UnknownState, Input>
          : Rule extends readonly ['arguments-union']
            ? CopyEnvironment<UnionArguments<Args>, Input>
            : Rule extends readonly ['reference-targets']
              ? [Input[1]] extends [never]
                ? CopyEnvironment<UnknownState, Input>
                : CopyEnvironment<[Input[1], never], Input>
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
    : CopyEnvironment<[States[0], never], States>

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
            : CopyEnvironment<[Left[0] | Right[0], CommonTargets<Left, Right>], Left>

type CommonTargets<Left extends InferenceState, Right extends InferenceState> = [Left[1]] extends [never]
  ? never
  : [Right[1]] extends [never]
    ? never
    : Left[1] | Right[1]

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
                RootTargetsOf<Result>,
                HostContextOf<Result>,
                ActiveHostDeclarationsOf<Result>,
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

type EnvOf<Context extends object> = Context extends { readonly env?: infer Env } ? Env : EmptyContextMap
type VarsOf<Context extends object> = Context extends { readonly vars?: infer Vars } ? Vars : EmptyContextMap
type FunctionsOf<Context extends object> = Context extends { readonly functions?: infer Functions }
  ? Functions
  : EmptyContextMap

type InferEmbeddedState<Expression extends string, Initial extends InferenceState> =
  Tokenize<Expression> extends infer Tokens
    ? Tokens extends TypeTokens
      ? TokenPolicy<Tokens> extends infer Policy
        ? Policy extends 'unsafe'
          ? CopyEnvironment<UnknownState, Initial>
          : ParseLoop<
                Tokens,
                [],
                [],
                [],
                Policy extends 'binding-fallback' ? WithOpaqueBindings<Initial> : Initial,
                'operand'
              > extends infer Result
            ? Result extends InferenceState
              ? Result
              : CopyEnvironment<UnknownState, Initial>
            : CopyEnvironment<UnknownState, Initial>
        : CopyEnvironment<UnknownState, Initial>
      : CopyEnvironment<UnknownState, Initial>
    : CopyEnvironment<UnknownState, Initial>

type WithOpaqueBindings<State extends InferenceState> = CoreOf<State> &
  EnvironmentCarrier<
    ['opaque', RootTypesOf<State>, RootTargetsOf<State>, HostContextOf<State>, ActiveHostDeclarationsOf<State>]
  >

type NameState<Name extends string, Context extends InferenceState> = Name extends keyof R4Resources & string
  ? CopyEnvironment<[Name, never], Context>
  : Navigate<Context, Name>

type SpecialState<Name extends 'this' | 'index' | 'total', Context extends InferenceState> = Name extends 'this'
  ? Context
  : Name extends 'index'
    ? CopyEnvironment<['System.Integer', never], Context>
    : CopyEnvironment<UnknownState, Context>

type ExternalState<Name extends string, Context extends InferenceState> =
  LookupBinding<BindingsOf<Context>, Name> extends infer Found
    ? [Found] extends [never]
      ? Name extends 'context' | 'resource' | 'rootResource'
        ? CopyEnvironment<[RootTypesOf<Context>, RootTargetsOf<Context>], Context>
        : Name extends 'ucum' | 'sct' | 'loinc' | `vs-${string}` | `ext-${string}`
          ? CopyEnvironment<['System.String', never], Context>
          : HostVariableState<Name, Context>
      : Found extends CoreState
        ? CopyEnvironment<Found, Context>
        : CopyEnvironment<UnknownState, Context>
    : CopyEnvironment<UnknownState, Context>

type HostVariableState<Name extends string, Context extends InferenceState> =
  LookupContextMap<EnvOf<HostContextOf<Context>>, Name> extends infer EnvDeclaration
    ? LookupContextMap<VarsOf<HostContextOf<Context>>, Name> extends infer VarDeclaration
      ? [EnvDeclaration] extends [never]
        ? [VarDeclaration] extends [never]
          ? CopyEnvironment<UnknownState, Context>
          : DeclaredVariableState<VarDeclaration, Name, Context>
        : [VarDeclaration] extends [never]
          ? DeclaredTypeState<EnvDeclaration, Context>
          : CopyEnvironment<OpaqueState, Context>
      : CopyEnvironment<UnknownState, Context>
    : CopyEnvironment<UnknownState, Context>

type DeclaredVariableState<Declaration, Name extends string, Context extends InferenceState> = Declaration extends {
  readonly __expression: infer Expression extends string
}
  ? `var:${Name}` extends ActiveHostDeclarationsOf<Context>
    ? CopyEnvironment<UnknownState, Context>
    : string extends Expression
      ? CopyEnvironment<UnknownState, Context>
      : InferEmbeddedState<Expression, VariableRootState<Context, ActiveHostDeclarationsOf<Context> | `var:${Name}`>>
  : DeclaredTypeState<Declaration, Context>

type DeclaredOnlyVars<Map> =
  Map extends Readonly<Record<PropertyKey, unknown>>
    ? {
        readonly [Name in keyof Map as Map[Name] extends { readonly __expression: string } ? never : Name]: Map[Name]
      }
    : EmptyContextMap

type VariableBodyHostContext<Context extends InferenceState> = {
  env: EnvOf<HostContextOf<Context>>
  vars: DeclaredOnlyVars<VarsOf<HostContextOf<Context>>>
  functions: FunctionsOf<HostContextOf<Context>>
}

type VariableRootState<Context extends InferenceState, Active extends string> = [RootTypesOf<Context>] extends [never]
  ? EmptyCore &
      EnvironmentCarrier<
        [BindingsOf<Context>, RootTypesOf<Context>, RootTargetsOf<Context>, VariableBodyHostContext<Context>, Active]
      >
  : [RootTypesOf<Context>] extends ['unknown']
    ? UnknownCore &
        EnvironmentCarrier<
          [BindingsOf<Context>, RootTypesOf<Context>, RootTargetsOf<Context>, VariableBodyHostContext<Context>, Active]
        >
    : [RootTypesOf<Context>, RootTargetsOf<Context>] &
        EnvironmentCarrier<
          [BindingsOf<Context>, RootTypesOf<Context>, RootTargetsOf<Context>, VariableBodyHostContext<Context>, Active]
        >

type DeclaredTypeState<Declaration, Context extends InferenceState> = Declaration extends {
  readonly type: infer Declared
}
  ? DeclarationTypeNames<Declared> extends infer Types extends string
    ? [Types] extends [never]
      ? CopyEnvironment<UnknownState, Context>
      : WideTypeName<Types> extends true
        ? CopyEnvironment<UnknownState, Context>
        : CopyEnvironment<[Canonical<Types>, DeclarationTargets<Declaration>], Context>
    : CopyEnvironment<UnknownState, Context>
  : CopyEnvironment<UnknownState, Context>

type DeclarationTypeNames<Declared> = Declared extends readonly string[]
  ? Declared[number]
  : Declared extends string
    ? Declared
    : never
type DeclarationTargets<Declaration> = Declaration extends { readonly targets: infer Targets }
  ? Targets extends readonly string[]
    ? Canonical<Targets[number]>
    : Targets extends string
      ? Canonical<Targets>
      : never
  : never
type WideTypeName<Types extends string> = keyof R4TypeOf extends Types ? true : false

type MemberState<Focus extends InferenceState, Name extends string> = Navigate<Focus, Name>

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

type InputState<
  Input extends string,
  HostContext extends object,
  TrackEnvironment extends boolean,
  BindingFallback extends boolean,
> =
  Normalize<Input> extends infer Name extends string
    ? Name extends keyof R4TypeOf
      ? BindingFallback extends true
        ? [Name, never] & EnvironmentCarrier<['opaque', Name, never, HostContext, never]>
        : TrackEnvironment extends true
          ? [Name, never] & EnvironmentCarrier<[[], Name, never, HostContext, never]>
          : HasHostContext<HostContext> extends true
            ? [Name, never] & EnvironmentCarrier<[[], Name, never, HostContext, never]>
            : [Name, never]
      : BindingFallback extends true
        ? UnknownCore & EnvironmentCarrier<['opaque', 'unknown', never, HostContext, never]>
        : TrackEnvironment extends true
          ? UnknownCore & EnvironmentCarrier<[[], 'unknown', never, HostContext, never]>
          : HasHostContext<HostContext> extends true
            ? UnknownCore & EnvironmentCarrier<[[], 'unknown', never, HostContext, never]>
            : UnknownCore
    : BindingFallback extends true
      ? UnknownCore & EnvironmentCarrier<['opaque', 'unknown', never, HostContext, never]>
      : TrackEnvironment extends true
        ? UnknownCore & EnvironmentCarrier<[[], 'unknown', never, HostContext, never]>
        : HasHostContext<HostContext> extends true
          ? UnknownCore & EnvironmentCarrier<[[], 'unknown', never, HostContext, never]>
          : UnknownCore

type FastInputState<Input extends string> =
  Normalize<Input> extends infer Name extends string
    ? Name extends keyof R4TypeOf
      ? [Name, never]
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
          : Information extends { t: infer Types extends string }
            ? CopyEnvironment<[Canonical<Types>, ReferenceTargets<Input[0], Element, Types>], Input>
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
          : CopyEnvironment<[Survivors, never], Input>
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
            : [Left[0] | Right[0], CommonTargets<Left, Right>]

type PublicResult<State extends CoreState> = [State[0]] extends [never]
  ? never[]
  : State[0] extends 'opaque'
    ? unknown[]
    : State[0] extends 'unknown'
      ? unknown[]
      : R4TypeOf[Extract<State[0], keyof R4TypeOf>][]

type LiteralState<Token extends LiteralToken> = Token[0] extends 'string'
  ? ['System.String', never]
  : Token[0] extends 'date'
    ? ['System.Date', never]
    : Token[0] extends 'dateTime'
      ? ['System.DateTime', never]
      : Token[0] extends 'time'
        ? ['System.Time', never]
        : UnknownState

type IndexResult<Stack extends Values, Index extends InferenceState> = Stack extends [
  ...infer Before extends Values,
  infer Target extends InferenceState,
]
  ? Index[0] extends 'System.Integer'
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
