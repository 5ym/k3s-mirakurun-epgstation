#!/usr/bin/env bash
# 偽 ffmpeg。E2E で「エンコードが走って mkv が出来る」ところまでを実 ffmpeg 無しで通す。
# 本物と同じく stderr に Duration を、stdout に -progress の key=value ブロックを吐く。
set -uo pipefail

output="${!#}"   # 最後の引数が出力ファイル
input=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "-i" ]; then input="$arg"; fi
    prev="$arg"
done

# CM検出パス (silencedetect) は本編とは別物として応答する。
# 300秒と360秒に境界が来るので、300-360 の 60 秒がCMブロックとして検出される。
if printf '%s\n' "$@" | grep -q silencedetect; then
    echo "  Duration: 00:10:00.00, start: 0.000000, bitrate: 15000 kb/s" >&2
    echo "[silencedetect @ 0x1] silence_start: 299.8" >&2
    echo "[silencedetect @ 0x1] silence_end: 300.2 | silence_duration: 0.4" >&2
    echo "[silencedetect @ 0x1] silence_start: 359.8" >&2
    echo "[silencedetect @ 0x1] silence_end: 360.2 | silence_duration: 0.4" >&2
    exit 0
fi

# CMを切るパス (-c copy で区間を切り出す / concat で繋ぐ)。
# 進捗も Duration も出さず、出力ファイルだけ作って終わる本物と同じ振る舞いにする
if printf '%s\n' "$@" | grep -qx -- '-c' && printf '%s\n' "$@" | grep -qx -- 'copy'; then
    mkdir -p "$(dirname "$output")"
    head -c 4096 /dev/zero > "$output"
    exit 0
fi

# ライブ配信(TS): stdin をそのまま stdout に流し続ける。
# 中身は本物のTSではないが、「切るまで流れ続ける」という性質だけは同じ
if [ "$output" = "pipe:1" ]; then
    # E2E から「映像側は入口で落ちる」と指示するための目印。
    #
    # 実機の tvk (T15) で出た形をそのまま真似る — 局が3つ相乗りしている TS で
    # -probesize が足りず、-map が解決できないまま降りる。**1バイトも出さずに
    # 降りるので、伝えないと画面は前の絵を貼ったまま6秒たって黒くなるだけ**。
    # 字幕側は落とさない (映像だけが死ぬ形を試したい)
    if [ -f "${FAKE_FFMPEG_LIVE_FAIL_FILE:-/nonexistent}" ] &&
        printf '%s\n' "$@" | grep -qx -- 'libx264'; then
        echo "Failed to set value '0:p:24632:v:0' for option 'map': Invalid argument" >&2
        echo "Error opening output files: Invalid argument" >&2
        exit 1
    fi
    # **何を渡されたかを残す。** 焼き方の指定は間違えても E2E では絵が要らないぶん
    # 素通りするので、テストから中身を見られるようにしておく。
    #
    # **1回ぶんずつ足していく。** ライブ視聴は映像と字幕で ffmpeg を2本起こすので、
    # 上書きにしていると後から起きたほうしか残らない (実際、字幕を足したときに
    # 映像側を見ていたテストが落ちた)。テスト側は `---` で切って選ぶ
    #
    # **1回の書き込みで済ませる。** 区切りと中身を別々に書いていた頃は、2本が
    # 同時に起きると「区切り・区切り・映像の引数・字幕の引数」の順に並ぶことが
    # あり、**2本ぶんが1回ぶんに見えて**いた (CI で落ちた)
    if [ -n "${FAKE_FFMPEG_ARGS_FILE:-}" ]; then
        printf -- '---\n%s\n' "$(printf '%s\n' "$@")" >> "$FAKE_FFMPEG_ARGS_FILE"
    fi

    # **渡された TS の頭を残す。** ライブは1局に絞ってから ffmpeg へ渡すので
    # (`server/live.ts` の pump)、渡ったものの PAT に局が1つしか無いことを
    # テストから確かめられるようにする。**頭だけ** — 全部残すと際限なく太る
    if [ -n "${FAKE_FFMPEG_TS_FILE:-}" ] &&
        printf '%s\n' "$@" | grep -qx -- 'libx264'; then
        exec tee >(head -c 200000 > "$FAKE_FFMPEG_TS_FILE" 2>/dev/null)
    fi
    exec cat
fi

echo "Input #0, mpegts, from '${input}':" >&2
echo "  Duration: 00:00:10.00, start: 0.000000, bitrate: 15000 kb/s" >&2

# E2E から「この先のエンコードは失敗させる」と指示するための目印。
# 失敗したときの表示と後始末を確かめるのに要る
if [ -f "${FAKE_FFMPEG_FAIL_FILE:-/nonexistent}" ]; then
    echo "[libsvtav1 @ 0x1] Error initializing the encoder" >&2
    echo "Conversion failed!" >&2
    exit 1
fi

if [ "${FAKE_FFMPEG_FAIL:-0}" = "1" ]; then
    echo "Error while opening encoder - fake failure" >&2
    exit 1
fi

steps="${FAKE_FFMPEG_STEPS:-4}"
for i in $(seq 1 "$steps"); do
    out_time_us=$((i * 10000000 / steps))
    printf 'frame=%d\nfps=120\nbitrate=2000.0kbits/s\ntotal_size=%d\nout_time_us=%d\nspeed=8.0x\ndrop_frames=0\nprogress=continue\n' \
        "$((i * 300))" "$((i * 1000000))" "$out_time_us"
    sleep 0.2
done

mkdir -p "$(dirname "$output")"
# 中身は問わないが、サイズ0だと「失敗」と見分けが付かないので少しだけ書く
head -c 4096 /dev/zero > "$output"

printf 'frame=1200\nfps=120\nbitrate=2000.0kbits/s\ntotal_size=4096\nout_time_us=10000000\nspeed=8.0x\ndrop_frames=0\nprogress=end\n'
exit 0
