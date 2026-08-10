import type { R4Bases, R4Elements, R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'
import type { CompactFunctionRules, CompactInfixParselets } from './generated/metadata-compact.ts'

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
                ? ReadQuoted<Rest, '', '`', 'unsafe', Tokens, Step<Steps>>
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
          ? ReadEscape<Rest, Acc, Quote, 'unsafe', Tokens, Step<Steps>>
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
  ? ReadQuoted<Source, `${Acc}${string}`, Quote, Kind, Tokens, Steps>
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

type TemporalCharacter = Digit | 'T' | 'Z' | '-' | '+' | ':' | '.'

type ReadTemporal<
  Source extends string,
  Acc extends string,
  Tokens extends TypeTokens,
  Steps extends unknown[],
> = Source extends ''
  ? Acc extends ''
    ? ScanFailure
    : EmitFinal<TemporalToken<Acc>, Tokens>
  : Steps['length'] extends 256
    ? ScanFailure
    : Source extends `${infer Character}${infer Rest}`
      ? Character extends TemporalCharacter
        ? ReadTemporal<Rest, `${Acc}${Character}`, Tokens, Step<Steps>>
        : Acc extends ''
          ? ScanFailure
          : EmitAndScan<Source, TemporalToken<Acc>, Tokens, Steps>
      : ScanFailure

type TemporalToken<Value extends string> = Value extends `T${string}`
  ? ['time', Value]
  : Value extends `${string}T${string}`
    ? ['dateTime', Value]
    : ['date', Value]

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
type InferenceState = [types: string, single: Cardinality, targets: string, rawInput: boolean, atom: string]
type OpaqueState = ['opaque', 'unknown', never, false, never]
type UnknownState = ['unknown', 'unknown', never, false, never]
type EmptyState = [never, true, never, false, never]
type Values = InferenceState[]
type BinaryOperatorFrame = ['binary', string, number]
type UnaryOperatorFrame = ['unary', '+' | '-', number]
type OperatorFrame = BinaryOperatorFrame | UnaryOperatorFrame
type Operators = OperatorFrame[]
type GroupFrame = ['group', Values, Operators, InferenceState]
type IndexFrame = ['index', Values, Operators, InferenceState, InferenceState]
type CallFrame = ['call', Values, Operators, InferenceState, InferenceState, string, InferenceState[]]
type DelimiterFrame = GroupFrame | IndexFrame | CallFrame
type Frames = DelimiterFrame[]
type ParseMode = 'operand' | 'operator' | 'member'

type TypeFunctionRules = CompactFunctionRules
type TypeInfixParselets = CompactInfixParselets
type FastMiss = { readonly fastMiss: true }

/** Parse and infer one expression without retaining an intermediate type-level AST. */
export type InferTypeExpression<
  Expression extends string,
  Input extends string,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> =
  FastExpression<Expression, Input, FixedFunctions, IdentityFunctions> extends infer Fast
    ? Fast extends InferenceState
      ? PublicResult<Fast>
      : InferSlowExpression<Expression, Input, FixedFunctions, IdentityFunctions>
    : unknown[]

type InferSlowExpression<
  Expression extends string,
  Input extends string,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> =
  Tokenize<Expression> extends infer Tokens
    ? Tokens extends TypeTokens
      ? ContainsUnsafe<Tokens> extends true
        ? unknown[]
        : ParseLoop<
              Tokens,
              [],
              [],
              [],
              InputState<Input>,
              'operand',
              FixedFunctions,
              IdentityFunctions
            > extends infer Result
          ? Result extends InferenceState
            ? PublicResult<Result>
            : unknown[]
          : unknown[]
      : unknown[]
    : unknown[]

/**
 * Model-known chains use a bounded shortcut. Four steps, 76-character resource
 * roots, 24-character arguments, and single-name select projections keep every
 * accepted source below both scanner caps. Anything with general argument
 * syntax, operators, trivia, or unknown names takes the tokenizer and stack
 * parser above.
 */
type FastExpression<
  Expression extends string,
  Input extends string,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Expression extends `${infer Root}.${infer Rest}`
  ? Root extends keyof R4Resources & string
    ? FastChain<Rest, [Root, true, never, false, Root], FixedFunctions, IdentityFunctions, []>
    : FastInputChain<Expression, Input, FixedFunctions, IdentityFunctions>
  : Expression extends keyof R4Resources & string
    ? [Expression, true, never, false, Expression]
    : FastInputChain<Expression, Input, FixedFunctions, IdentityFunctions>

type FastInputChain<
  Expression extends string,
  Input extends string,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> =
  InputState<Input> extends infer Context extends InferenceState
    ? Context[0] extends 'unknown' | 'opaque'
      ? FastMiss
      : FastChain<Expression, Context, FixedFunctions, IdentityFunctions, []>
    : FastMiss

type FastChain<
  Expression extends string,
  State extends InferenceState,
  FixedFunctions extends string,
  IdentityFunctions extends string,
  Steps extends unknown[],
> = Steps['length'] extends 4
  ? FastMiss
  : Expression extends `${infer Segment}.${infer Rest}`
    ? FastStep<Segment, State, FixedFunctions, IdentityFunctions> extends infer Next
      ? Next extends InferenceState
        ? FastChain<Rest, Next, FixedFunctions, IdentityFunctions, [...Steps, 0]>
        : FastMiss
      : FastMiss
    : FastStep<Expression, State, FixedFunctions, IdentityFunctions>

type FastStep<
  Segment extends string,
  State extends InferenceState,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Segment extends `${infer Name}[${infer Index}]`
  ? Index extends Digit
    ? FastNavigate<State, Name>
    : FastMiss
  : Segment extends `${infer Name}()`
    ? Name extends FixedFunctions | IdentityFunctions
      ? FastCallResult<ApplyCall<State, Name, [], FixedFunctions, IdentityFunctions>>
      : FastMiss
    : Segment extends `${infer Name}(${infer Argument})`
      ? Name extends 'ofType' | 'as'
        ? Argument extends keyof R4TypeOf & string
          ? ShortText<Argument, 32> extends true
            ? FastCallResult<
                ApplyCall<
                  State,
                  Name,
                  [['unknown', 'unknown', never, false, Argument]],
                  FixedFunctions,
                  IdentityFunctions
                >
              >
            : FastMiss
          : FastMiss
        : Name extends 'select'
          ? IdentifierText<Argument> extends true
            ? FastNavigate<SetSingle<State, true>, Argument> extends infer Projection
              ? Projection extends InferenceState
                ? FastCallResult<ApplyCall<State, Name, [Projection], FixedFunctions, IdentityFunctions>>
                : FastMiss
              : FastMiss
            : FastMiss
          : Name extends FixedFunctions | IdentityFunctions
            ? FastArgumentShape<Argument> extends true
              ? ShortSafeArgument<Argument> extends true
                ? FastCallResult<ApplyCall<State, Name, [UnknownState], FixedFunctions, IdentityFunctions>>
                : FastMiss
              : FastMiss
            : FastMiss
      : FastNavigate<State, Segment>

type FastNavigate<State extends InferenceState, Name extends string> =
  Navigate<State, Name> extends infer Result
    ? Result extends InferenceState
      ? Result[0] extends 'unknown' | 'opaque'
        ? FastMiss
        : Result
      : FastMiss
    : FastMiss

type FastCallResult<State extends InferenceState> = State[0] extends 'unknown' | 'opaque' ? FastMiss : State

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
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Mode extends 'operand'
  ? ParseOperand<Tokens, Stack, Ops, Delimiters, Context, FixedFunctions, IdentityFunctions>
  : Mode extends 'member'
    ? ParseMember<Tokens, Stack, Ops, Delimiters, Context, FixedFunctions, IdentityFunctions>
    : ParseOperator<Tokens, Stack, Ops, Delimiters, Context, FixedFunctions, IdentityFunctions>

type ParseOperand<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Tokens extends []
  ? OpaqueState
  : Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
    ? Token extends ['name', infer Name extends string]
      ? Rest extends [['symbol', '('], ...infer AfterOpen extends TypeTokens]
        ? StartCall<AfterOpen, Stack, Ops, Delimiters, Context, Context, Name, FixedFunctions, IdentityFunctions>
        : ParseLoop<
            Rest,
            [...Stack, NameState<Name, Context>],
            Ops,
            Delimiters,
            Context,
            'operator',
            FixedFunctions,
            IdentityFunctions
          >
      : Token extends ['keyword', infer Word extends string]
        ? Word extends 'true' | 'false'
          ? ParseLoop<
              Rest,
              [...Stack, UnknownState],
              Ops,
              Delimiters,
              Context,
              'operator',
              FixedFunctions,
              IdentityFunctions
            >
          : Word extends 'as' | 'contains' | 'in' | 'is'
            ? Rest extends [['symbol', '('], ...infer AfterOpen extends TypeTokens]
              ? StartCall<AfterOpen, Stack, Ops, Delimiters, Context, Context, Word, FixedFunctions, IdentityFunctions>
              : ParseLoop<
                  Rest,
                  [...Stack, NameState<Word, Context>],
                  Ops,
                  Delimiters,
                  Context,
                  'operator',
                  FixedFunctions,
                  IdentityFunctions
                >
            : OpaqueState
        : Token extends LiteralToken
          ? ParseLoop<
              Rest,
              [...Stack, LiteralState<Token>],
              Ops,
              Delimiters,
              Context,
              'operator',
              FixedFunctions,
              IdentityFunctions
            >
          : Token extends ['special', infer Special extends 'this' | 'index' | 'total']
            ? ParseLoop<
                Rest,
                [...Stack, SpecialState<Special, Context>],
                Ops,
                Delimiters,
                Context,
                'operator',
                FixedFunctions,
                IdentityFunctions
              >
            : Token extends ['symbol', '%']
              ? ParseExternal<Rest, Stack, Ops, Delimiters, Context, FixedFunctions, IdentityFunctions>
              : Token extends ['symbol', '(']
                ? ParseLoop<
                    Rest,
                    [],
                    [],
                    [['group', Stack, Ops, Context], ...Delimiters],
                    Context,
                    'operand',
                    FixedFunctions,
                    IdentityFunctions
                  >
                : Token extends ['symbol', '{']
                  ? Rest extends [['symbol', '}'], ...infer AfterEmpty extends TypeTokens]
                    ? ParseLoop<
                        AfterEmpty,
                        [...Stack, EmptyState],
                        Ops,
                        Delimiters,
                        Context,
                        'operator',
                        FixedFunctions,
                        IdentityFunctions
                      >
                    : OpaqueState
                  : Token extends ['symbol', infer Unary extends '+' | '-']
                    ? ParseLoop<
                        Rest,
                        Stack,
                        [...Ops, ['unary', Unary, 12]],
                        Delimiters,
                        Context,
                        'operand',
                        FixedFunctions,
                        IdentityFunctions
                      >
                    : Token extends ['symbol', ')']
                      ? CloseEmptyCall<Rest, Stack, Ops, Delimiters, Context, FixedFunctions, IdentityFunctions>
                      : OpaqueState
    : OpaqueState

type ParseExternal<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
  ? Token extends ['name' | 'string', infer Name extends string]
    ? ParseLoop<
        Rest,
        [...Stack, ['unknown', 'unknown', never, false, `%${Name}`]],
        Ops,
        Delimiters,
        Context,
        'operator',
        FixedFunctions,
        IdentityFunctions
      >
    : OpaqueState
  : OpaqueState

type ParseMember<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Stack extends [...infer Before extends Values, infer Focus extends InferenceState]
  ? Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
    ? Token extends ['name' | 'keyword', infer Name extends string]
      ? Name extends 'true' | 'false'
        ? OpaqueState
        : Rest extends [['symbol', '('], ...infer AfterOpen extends TypeTokens]
          ? StartCall<AfterOpen, Before, Ops, Delimiters, Context, Focus, Name, FixedFunctions, IdentityFunctions>
          : ParseLoop<
              Rest,
              [...Before, Navigate<Focus, Name>],
              Ops,
              Delimiters,
              Context,
              'operator',
              FixedFunctions,
              IdentityFunctions
            >
      : Token extends ['special', infer Special extends 'this' | 'index' | 'total']
        ? ParseLoop<
            Rest,
            [...Before, SpecialState<Special, Focus>],
            Ops,
            Delimiters,
            Context,
            'operator',
            FixedFunctions,
            IdentityFunctions
          >
        : OpaqueState
    : OpaqueState
  : OpaqueState

type ParseOperator<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Tokens extends []
  ? Delimiters extends []
    ? FinishRoot<Stack, Ops>
    : OpaqueState
  : Tokens extends [infer Token extends TypeToken, ...infer Rest extends TypeTokens]
    ? Token extends ['symbol', '.']
      ? ParseletReducer<'.'> extends 'dot'
        ? ParseLoop<Rest, Stack, Ops, Delimiters, Context, 'member', FixedFunctions, IdentityFunctions>
        : OpaqueState
      : Token extends ['symbol', '[']
        ? ParseletReducer<'['> extends 'indexer'
          ? Stack extends [...Values, InferenceState]
            ? ParseLoop<
                Rest,
                [],
                [],
                [['index', Stack, Ops, Context, Last<Stack>], ...Delimiters],
                Context,
                'operand',
                FixedFunctions,
                IdentityFunctions
              >
            : OpaqueState
          : OpaqueState
        : Token extends ['symbol', ']' | ')'] | ['symbol', ',']
          ? CloseDelimited<Token[1], Rest, Stack, Ops, Delimiters, Context, FixedFunctions, IdentityFunctions>
          : Token extends ['symbol' | 'keyword', infer Operator extends string]
            ? Operator extends 'is' | 'as'
              ? ParseTypeOperator<Operator, Rest, Stack, Ops, Delimiters, Context, FixedFunctions, IdentityFunctions>
              : Operator extends keyof TypeInfixParselets
                ? ParseletReducer<Operator> extends 'binary'
                  ? PushBinary<
                      Operator,
                      ParseletBindingPower<Operator>,
                      Rest,
                      Stack,
                      Ops,
                      Delimiters,
                      Context,
                      FixedFunctions,
                      IdentityFunctions
                    >
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
  FixedFunctions extends string,
  IdentityFunctions extends string,
> =
  ParseletReducer<'('> extends 'call'
    ? ParseLoop<
        Tokens,
        [],
        [],
        [['call', OuterStack, OuterOps, OuterContext, Focus, Name, []], ...Delimiters],
        Focus,
        'operand',
        FixedFunctions,
        IdentityFunctions
      >
    : OpaqueState

type CloseEmptyCall<
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  _Context extends InferenceState,
  FixedFunctions extends string,
  IdentityFunctions extends string,
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
            [...OuterStack, ApplyCall<Focus, Name, [], FixedFunctions, IdentityFunctions>],
            OuterOps,
            OuterFrames,
            OuterContext,
            'operator',
            FixedFunctions,
            IdentityFunctions
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
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Ops extends [...infer Remaining extends Operators, infer Top extends OperatorFrame]
  ? ReduceOne<Stack, Top> extends infer Reduced
    ? Reduced extends Values
      ? CloseDelimited<Delimiter, Tokens, Reduced, Remaining, Delimiters, Context, FixedFunctions, IdentityFunctions>
      : OpaqueState
    : OpaqueState
  : Stack extends [infer Result extends InferenceState]
    ? ResumeDelimiter<Delimiter, Tokens, Result, Delimiters, FixedFunctions, IdentityFunctions>
    : OpaqueState

type ResumeDelimiter<
  Delimiter extends string,
  Tokens extends TypeTokens,
  Result extends InferenceState,
  Delimiters extends Frames,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Delimiters extends [infer Frame extends DelimiterFrame, ...infer OuterFrames extends Frames]
  ? Frame extends [
      'group',
      infer OuterStack extends Values,
      infer OuterOps extends Operators,
      infer OuterContext extends InferenceState,
    ]
    ? Delimiter extends ')'
      ? ParseLoop<
          Tokens,
          [...OuterStack, Result],
          OuterOps,
          OuterFrames,
          OuterContext,
          'operator',
          FixedFunctions,
          IdentityFunctions
        >
      : OpaqueState
    : Frame extends [
          'index',
          infer OuterStack extends Values,
          infer OuterOps extends Operators,
          infer OuterContext extends InferenceState,
          infer _Target extends InferenceState,
        ]
      ? Delimiter extends ']'
        ? ParseLoop<
            Tokens,
            IndexResult<OuterStack, Result>,
            OuterOps,
            OuterFrames,
            OuterContext,
            'operator',
            FixedFunctions,
            IdentityFunctions
          >
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
              Focus,
              'operand',
              FixedFunctions,
              IdentityFunctions
            >
          : Delimiter extends ')'
            ? ParseLoop<
                Tokens,
                [...OuterStack, ApplyCall<Focus, Name, [...Args, Result], FixedFunctions, IdentityFunctions>],
                OuterOps,
                OuterFrames,
                OuterContext,
                'operator',
                FixedFunctions,
                IdentityFunctions
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
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Ops extends [...infer Remaining extends Operators, infer Top extends OperatorFrame]
  ? GreaterThanOrEqual<OperatorBindingPower<Top>, BindingPower> extends true
    ? ReduceOne<Stack, Top> extends infer Reduced
      ? Reduced extends Values
        ? PushBinary<
            Operator,
            BindingPower,
            Tokens,
            Reduced,
            Remaining,
            Delimiters,
            Context,
            FixedFunctions,
            IdentityFunctions
          >
        : OpaqueState
      : OpaqueState
    : ParseLoop<
        Tokens,
        Stack,
        [...Ops, ['binary', Operator, BindingPower]],
        Delimiters,
        Context,
        'operand',
        FixedFunctions,
        IdentityFunctions
      >
  : ParseLoop<
      Tokens,
      Stack,
      [['binary', Operator, BindingPower]],
      Delimiters,
      Context,
      'operand',
      FixedFunctions,
      IdentityFunctions
    >

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
  ? Stack extends [...infer Before extends Values, InferenceState]
    ? [...Before, OpaqueState]
    : OpaqueState
  : Operator extends ['binary', infer Name extends string, number]
    ? Stack extends [
        ...infer Before extends Values,
        infer Left extends InferenceState,
        infer Right extends InferenceState,
      ]
      ? [...Before, ApplyBinary<Name, Left, Right>]
      : OpaqueState
    : OpaqueState

type ApplyBinary<Name extends string, Left extends InferenceState, Right extends InferenceState> = Name extends '|'
  ? UnionState<Left, Right>
  : OpaqueState

type ParseTypeOperator<
  _Operator extends 'is' | 'as',
  Tokens extends TypeTokens,
  Stack extends Values,
  Ops extends Operators,
  Delimiters extends Frames,
  Context extends InferenceState,
  FixedFunctions extends string,
  IdentityFunctions extends string,
> =
  ConsumeTypeName<Tokens> extends [infer _TypeName extends string, infer Rest extends TypeTokens]
    ? Stack extends [...infer Before extends Values, InferenceState]
      ? ParseLoop<
          Rest,
          [...Before, OpaqueState],
          Ops,
          Delimiters,
          Context,
          'operator',
          FixedFunctions,
          IdentityFunctions
        >
      : OpaqueState
    : OpaqueState

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

type ApplyCall<
  Input extends InferenceState,
  Name extends string,
  Args extends InferenceState[],
  FixedFunctions extends string,
  IdentityFunctions extends string,
> = Input[0] extends 'opaque'
  ? OpaqueState
  : Name extends 'select'
    ? Args extends [infer Projection extends InferenceState, ...InferenceState[]]
      ? SetSingle<Projection, BothSingle<Input[1], Projection[1]>>
      : OpaqueState
    : Name extends 'ofType' | 'as'
      ? Args extends [infer Argument extends InferenceState, ...InferenceState[]]
        ? Argument[4] extends keyof R4TypeOf & string
          ? Narrow<Input, Argument[4]>
          : OpaqueState
        : OpaqueState
      : Name extends FixedFunctions
        ? Name extends keyof TypeFunctionRules
          ? ApplyBaselineRule<TypeFunctionRules[Name], Input>
          : OpaqueState
        : Name extends IdentityFunctions
          ? Name extends keyof TypeFunctionRules
            ? ApplyBaselineRule<TypeFunctionRules[Name], Input>
            : OpaqueState
          : OpaqueState

type ApplyBaselineRule<Rule, Input extends InferenceState> = Rule extends {
  readonly 0: 'fixed'
  readonly 1: infer Type extends string
  readonly 2: infer Single extends boolean
}
  ? [Canonical<Type>, Single, never, false, never]
  : Rule extends readonly ['input']
    ? Input
    : Rule extends readonly ['input-item']
      ? SetSingle<Input, true>
      : OpaqueState

type NameState<Name extends string, Context extends InferenceState> = Name extends keyof R4Resources & string
  ? [Name, true, never, false, Name]
  : SetAtom<Navigate<Context, Name>, Name>

type SpecialState<Name extends 'this' | 'index' | 'total', Context extends InferenceState> = Name extends 'this'
  ? SetSingle<Context, true>
  : OpaqueState

type InputState<Input extends string> =
  Normalize<Input> extends infer Name extends string
    ? Name extends keyof R4TypeOf
      ? [Name, true, never, true, never]
      : UnknownState
    : UnknownState

type Navigate<Input extends InferenceState, Element extends string> = Input[0] extends 'opaque'
  ? OpaqueState
  : Input[0] extends 'unknown'
    ? UnknownState
    : ElementInformation<Input[0], Element> extends infer Information
      ? [Information] extends [never]
        ? UnknownState
        : Information extends { t: infer Types extends string; a: infer Array extends boolean }
          ? [
              Canonical<Types>,
              Input[1] extends true ? (true extends Array ? false : true) : Input[1],
              never,
              false,
              never,
            ]
          : OpaqueState
      : OpaqueState

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

type Narrow<Input extends InferenceState, Target extends string> = Input[0] extends 'opaque'
  ? OpaqueState
  : Input[0] extends 'unknown'
    ? UnknownState
    : TypesOverlap<Input[0], Normalize<Target>> extends true
      ? [Normalize<Target>, Input[1], never, false, never]
      : OpaqueState

type IsSubtype<Type extends string, Base extends string, Seen extends string = never> = Type extends Base
  ? true
  : Type extends Seen
    ? false
    : Type extends keyof R4Bases
      ? R4Bases[Type] extends string
        ? IsSubtype<R4Bases[Type], Base, Seen | Type>
        : false
      : false

type PairOverlaps<Left extends string, Right extends string> =
  IsSubtype<Left, Right> extends true ? true : IsSubtype<Right, Left> extends true ? true : false

type TypesOverlap<Left extends string, Right extends string> = true extends (
  Left extends Left ? (Right extends Right ? PairOverlaps<Left, Right> : never) : never
)
  ? true
  : false

type UnionState<Left extends InferenceState, Right extends InferenceState> = Left[0] extends 'opaque'
  ? OpaqueState
  : Right[0] extends 'opaque'
    ? OpaqueState
    : Left[0] extends 'unknown'
      ? UnknownState
      : Right[0] extends 'unknown'
        ? UnknownState
        : [Left[0] | Right[0], false, never, false, never]

type SetSingle<State extends InferenceState, Single extends Cardinality> = [
  State[0],
  Single,
  State[2],
  State[3],
  State[4],
]

type SetAtom<State extends InferenceState, Atom extends string> = [State[0], State[1], State[2], State[3], Atom]

type BothSingle<Left extends Cardinality, Right extends Cardinality> = Left extends false
  ? false
  : Right extends false
    ? false
    : Left extends true
      ? Right
      : 'unknown'

type PublicResult<State extends InferenceState> = State[0] extends 'opaque'
  ? unknown[]
  : State[0] extends 'unknown'
    ? unknown[]
    : R4TypeOf[Extract<State[0], keyof R4TypeOf>][]

type LiteralState<Token extends LiteralToken> = Token[0] extends 'number'
  ? ['unknown', 'unknown', never, false, 'number']
  : UnknownState

type IndexResult<Stack extends Values, Index extends InferenceState> = Stack extends [
  ...infer Before extends Values,
  infer Target extends InferenceState,
]
  ? Index[4] extends 'number'
    ? [...Before, Target]
    : [...Before, OpaqueState]
  : [OpaqueState]

type ContainsUnsafe<Tokens extends TypeTokens> = Tokens extends [
  infer Token extends TypeToken,
  ...infer Rest extends TypeTokens,
]
  ? Token extends UnsafeToken
    ? true
    : ContainsUnsafe<Rest>
  : false

type Last<Stack extends Values> = Stack extends [...Values, infer Value extends InferenceState] ? Value : OpaqueState

type ParseletReducer<Token extends keyof TypeInfixParselets> = TypeInfixParselets[Token][5]
type ParseletBindingPower<Token extends keyof TypeInfixParselets> = TypeInfixParselets[Token][2]
type OperatorBindingPower<Operator extends OperatorFrame> = Operator[2]

type GreaterThanOrEqual<
  Left extends number,
  Right extends number,
  Count extends unknown[] = [],
> = Count['length'] extends Right
  ? true
  : Count['length'] extends Left
    ? false
    : GreaterThanOrEqual<Left, Right, [...Count, 0]>
