/**
 * 届いた字幕を、映像に合わせて出す順に並べる。**DOM を触らない。**
 *
 * **H.264 は届いたら出す。** 届いた字幕は、その時点で映っている絵に属している。
 * AV1 だけ符号器が溜め込むぶん待たせる (`captionLead` に値がある)。
 *
 * 時刻は**受け側の再生位置 (mp4 の秒)** で持つ。放送の時刻では持たない —
 * mp4 の 0 がどの放送時刻に当たるかは多重化器が決めるので (実機で確かめると
 * `-copyts` を付けても muxer が 0 へ寄せ直す)、こちらからは知りようがない。
 */

/** 出す時刻と、その絵。`bitmap` が null なら「消す」 */
export interface Cue {
    /** 受け側の再生位置 (秒)。ここを追い越したら出す */
    at: number;
    bitmap: ImageBitmap | null;
}

/**
 * 届いた字幕を**いつ出すか**。
 *
 * **合わせる先は「いま映っている絵」。** 届いた字幕は、その時点で映って
 * いる絵に属している — 放送は字幕を前もって送るが、映像を焼いて包む手間が
 * それを食うので、届いた時点では追い越されていない。
 *
 * **「いちばん新しく届いている映像」(`buffered.end`) に置いていた頃は、
 * 貯めているぶんだけ遅れて出ていた** (実測 0.2秒)。あちらは「字幕の映像は
 * まだ届いていない」という読みに立った置き方で、その読みが違った。
 * 貯めている量は宅外だと伸びるので、遅れもそのぶん伸びていた。
 *
 * @param now いまの再生位置
 * @param lead どれだけ待たせるか (秒)。サーバが焼き方から決めて寄越す
 *   (`server/live.ts` の `captionLead`)。**H.264 は 0**、AV1 だけ符号器が
 *   溜め込むぶん待たせる
 */
export function captionAt(now: number, lead: number): number {
    return now + lead;
}

/**
 * 溜めておく上限。**止めて見ている人のぶん。**
 *
 * 押して止めている間も受け取り続けるので、放っておくと際限なく増える。
 * 遅れて見られる長さ (`live-player` の `KEEP` = 5分) を、字幕の出る間隔
 * (実機で毎分18回) で数えたぶんより多めに採る
 */
export const KEEP_CUES = 200;

/**
 * 再生位置に合うものを選ぶ。**過ぎたものの中でいちばん新しい1つ。**
 *
 * 字幕は次が来るまで出しっぱなしなので、「いま出すもの」は
 * **時刻が再生位置を追い越していない中の、最後の1つ**になる。
 * 跳んだ直後もこれで正しく追いつく (間の枚を1つずつ出す必要が無い)。
 *
 * @returns 出すもの。何も出さないなら null
 */
export function currentCue(cues: Cue[], at: number): Cue | null {
    let found: Cue | null = null;
    for (const cue of cues) {
        if (cue.at > at) break;
        found = cue;
    }
    return found;
}

/**
 * 出し終わったものを捨てる。**いま出している1つは残す。**
 *
 * 残さないと、次が来るまでの間に出すものが無くなる (字幕は出しっぱなし)。
 * 上限を超えたぶんは、古いほうから落とす。
 *
 * @param at いまの再生位置 (秒)
 */
export function trimCues(cues: Cue[], at: number): Cue[] {
    // 過ぎたものの中でいちばん新しい1つより前は、もう使わない
    let keepFrom = 0;
    for (let i = 0; i < cues.length; i++) {
        if (cues[i].at > at) break;
        keepFrom = i;
    }
    const kept = cues.slice(keepFrom);
    return kept.length > KEEP_CUES ? kept.slice(kept.length - KEEP_CUES) : kept;
}

/**
 * 並びを保ったまま入れる。**届く順は前後しうる。**
 *
 * 同じ時刻のものが来たら**後から来たほうを採る** (出し直しなので新しいほうが正しい)。
 */
export function insertCue(cues: Cue[], cue: Cue): Cue[] {
    if (cues.length === 0 || cues[cues.length - 1].at < cue.at) return [...cues, cue];
    const out = cues.filter((held) => held.at !== cue.at);
    const at = out.findIndex((held) => held.at > cue.at);
    if (at < 0) return [...out, cue];
    return [...out.slice(0, at), cue, ...out.slice(at)];
}
