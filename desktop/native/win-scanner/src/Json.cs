using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Paperwing.Scan;

/// <summary>
/// Just enough JSON for the protocol (no dependency to load at startup):
/// writes dictionaries, lists, strings, numbers and booleans; parses
/// objects into Dictionary&lt;string, object?&gt;, arrays into List&lt;object?&gt;,
/// numbers into double.
/// </summary>
internal static class Json
{
    public static string Write(object? value)
    {
        var sb = new StringBuilder();
        WriteValue(sb, value);
        return sb.ToString();
    }

    private static void WriteValue(StringBuilder sb, object? value)
    {
        switch (value)
        {
            case null:
                sb.Append("null");
                break;
            case string s:
                WriteString(sb, s);
                break;
            case bool b:
                sb.Append(b ? "true" : "false");
                break;
            case int or long or short or uint or ushort or byte or sbyte:
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                break;
            case double d:
                WriteNumber(sb, d);
                break;
            case float f:
                WriteNumber(sb, f);
                break;
            case decimal m:
                WriteNumber(sb, (double)m);
                break;
            case IDictionary<string, object?> dict:
                sb.Append('{');
                var first = true;
                foreach (var pair in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, pair.Key);
                    sb.Append(':');
                    WriteValue(sb, pair.Value);
                }
                sb.Append('}');
                break;
            case IEnumerable list:
                sb.Append('[');
                var firstItem = true;
                foreach (var item in list)
                {
                    if (!firstItem) sb.Append(',');
                    firstItem = false;
                    WriteValue(sb, item);
                }
                sb.Append(']');
                break;
            default:
                WriteString(sb, Convert.ToString(value, CultureInfo.InvariantCulture) ?? "");
                break;
        }
    }

    private static void WriteNumber(StringBuilder sb, double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d))
            sb.Append("null");
        else if (d == Math.Floor(d) && Math.Abs(d) < 1e15)
            sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
        else
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
    }

    private static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    // Control characters, and the two line separators JavaScript
                    // treats as line breaks: escaped, so one object stays one line
                    if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029)
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else
                        sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    public static object? Parse(string text)
    {
        var reader = new Reader(text);
        reader.SkipSpace();
        var value = reader.ReadValue(0);
        reader.SkipSpace();
        if (!reader.AtEnd) throw new FormatException("Unexpected text after JSON value");
        return value;
    }

    private sealed class Reader
    {
        private const int MaxDepth = 32;
        private readonly string _s;
        private int _i;

        public Reader(string s) => _s = s;

        public bool AtEnd => _i >= _s.Length;

        public void SkipSpace()
        {
            while (_i < _s.Length && char.IsWhiteSpace(_s[_i])) _i++;
        }

        private char Peek() => _i < _s.Length ? _s[_i] : throw new FormatException("Unexpected end of JSON");

        public object? ReadValue(int depth)
        {
            if (depth > MaxDepth) throw new FormatException("JSON nested too deeply");
            var c = Peek();
            switch (c)
            {
                case '{': return ReadObject(depth);
                case '[': return ReadArray(depth);
                case '"': return ReadString();
                case 't': Expect("true"); return true;
                case 'f': Expect("false"); return false;
                case 'n': Expect("null"); return null;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber();
                    throw new FormatException($"Unexpected character '{c}' in JSON");
            }
        }

        private void Expect(string word)
        {
            if (string.CompareOrdinal(_s, _i, word, 0, word.Length) != 0)
                throw new FormatException($"Expected {word}");
            _i += word.Length;
        }

        private Dictionary<string, object?> ReadObject(int depth)
        {
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            _i++;
            SkipSpace();
            if (Peek() == '}')
            {
                _i++;
                return result;
            }
            while (true)
            {
                SkipSpace();
                if (Peek() != '"') throw new FormatException("Expected a property name");
                var key = ReadString();
                SkipSpace();
                if (Peek() != ':') throw new FormatException("Expected ':'");
                _i++;
                SkipSpace();
                result[key] = ReadValue(depth + 1);
                SkipSpace();
                var c = Peek();
                _i++;
                if (c == '}') return result;
                if (c != ',') throw new FormatException("Expected ',' or '}'");
            }
        }

        private List<object?> ReadArray(int depth)
        {
            var result = new List<object?>();
            _i++;
            SkipSpace();
            if (Peek() == ']')
            {
                _i++;
                return result;
            }
            while (true)
            {
                SkipSpace();
                result.Add(ReadValue(depth + 1));
                SkipSpace();
                var c = Peek();
                _i++;
                if (c == ']') return result;
                if (c != ',') throw new FormatException("Expected ',' or ']'");
            }
        }

        private string ReadString()
        {
            var sb = new StringBuilder();
            _i++;
            while (true)
            {
                var c = Peek();
                _i++;
                if (c == '"') return sb.ToString();
                if (c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                var e = Peek();
                _i++;
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (_i + 4 > _s.Length) throw new FormatException("Bad \\u escape");
                        sb.Append((char)int.Parse(_s.Substring(_i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        _i += 4;
                        break;
                    default: throw new FormatException("Bad escape in JSON string");
                }
            }
        }

        private double ReadNumber()
        {
            var start = _i;
            while (_i < _s.Length && "+-0123456789.eE".IndexOf(_s[_i]) >= 0) _i++;
            if (!double.TryParse(_s.Substring(start, _i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
                throw new FormatException("Bad number in JSON");
            return d;
        }
    }
}
