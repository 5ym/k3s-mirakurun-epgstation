import { describe, expect, test } from 'bun:test';
import { type Cue, captionAt, currentCue, insertCue, KEEP_CUES, trimCues } from './captions';

const cue = (at: number): Cue => ({ at, bitmap: null });

/**
 * **合わせる先は「いま映っている絵」。**
 *
 * 「いちばん新しく届いている映像」(`buffered.end`) に置いていた頃は、貯めて
 * いるぶんだけ遅れて出ていた (実機で 0.2秒)。宅外だと貯めが伸びるので、
 * 遅れもそのぶん伸びる。
 */
describe('captionAt', () => {
    /** H.264 は待たせないので、届いたら再生位置にそのまま置く */
    test('待たせないなら再生位置そのもの', () => {
        expect(captionAt(12.0, 0)).toBeCloseTo(12.0);
    });

    /** AV1 は符号器が溜め込むぶん、映像だけが遅れて届く */
    test('待たせる量だけ後ろに置く', () => {
        expect(captionAt(12.0, 0.9)).toBeCloseTo(12.9);
    });

    test('待たせる量が長いほど後ろに置く', () => {
        expect(captionAt(10, 1.25)).toBeGreaterThan(captionAt(10, 0.9));
    });

    /** **貯めている量に触れない。** そこが遅れの出どころだった */
    test('貯めている量は式に出てこない', () => {
        expect(captionAt(10, 0)).toBeCloseTo(10);
    });
});

/**
 * **字幕は映像より早く届く。** 映像はエンコードを通るぶん遅れるが、字幕は
 * 絵にするだけで通り抜ける。届いた端から出すと、口が動く前に台詞が出る。
 */
describe('currentCue', () => {
    const cues = [cue(10), cue(20), cue(30)];

    /** まだどれも時刻に達していない。**何も出さない** */
    test('再生位置より先のものは出さない', () => {
        expect(currentCue(cues, 5)).toBeNull();
        expect(currentCue(cues, 9.9)).toBeNull();
    });

    /*
     * **字幕は次が来るまで出しっぱなし。** だから「いま出すもの」は
     * 追い越していない中の**最後の1つ**で、ちょうど1枚ずつ送り出すのではない
     */
    test('過ぎたものの中でいちばん新しい1つを出す', () => {
        expect(currentCue(cues, 10)?.at).toBe(10);
        expect(currentCue(cues, 19.9)?.at).toBe(10);
        expect(currentCue(cues, 20)?.at).toBe(20);
        expect(currentCue(cues, 999)?.at).toBe(30);
    });

    /** 跳んだ直後もこれで追いつく。間の枚を1つずつ出す必要が無い */
    test('跳んでも間を通らずに追いつく', () => {
        expect(currentCue(cues, 30)?.at).toBe(30);
    });

    test('何も無ければ null', () => {
        expect(currentCue([], 10)).toBeNull();
    });
});

/**
 * **止めて見ている間も受け取り続ける。** 放っておくと際限なく増えるので刈るが、
 * いま出している1枚を捨ててはいけない (出しっぱなしのものなので、捨てると
 * 次の字幕まで何も出なくなる)。
 */
describe('trimCues', () => {
    test('いま出している1枚は残す', () => {
        const cues = [cue(10), cue(20), cue(30)];
        const kept = trimCues(cues, 25);
        expect(kept.map((c) => c.at)).toEqual([20, 30]);
    });

    test('まだどれも過ぎていなければ何も捨てない', () => {
        const cues = [cue(10), cue(20)];
        expect(trimCues(cues, 5)).toHaveLength(2);
    });

    test('上限を超えたら古いほうから落とす', () => {
        const cues = Array.from({ length: KEEP_CUES + 50 }, (_, i) => cue(1000 + i));
        // まだどれも過ぎていないので、落ちるのは上限のぶんだけ
        const kept = trimCues(cues, 0);
        expect(kept).toHaveLength(KEEP_CUES);
        expect(kept[kept.length - 1].at).toBe(1000 + KEEP_CUES + 49);
    });
});

/** 別々の口から来るので、届く順は前後しうる */
describe('insertCue', () => {
    test('時刻の順に並べる', () => {
        let cues: Cue[] = [];
        cues = insertCue(cues, cue(30));
        cues = insertCue(cues, cue(10));
        cues = insertCue(cues, cue(20));
        expect(cues.map((c) => c.at)).toEqual([10, 20, 30]);
    });

    /** 出し直しなので、同じ時刻なら後から来たほうが正しい */
    test('同じ時刻は後から来たほうを採る', () => {
        const first = { at: 10, bitmap: null };
        const second = { at: 10, bitmap: null };
        const cues = insertCue(insertCue([], first), second);
        expect(cues).toHaveLength(1);
        expect(cues[0]).toBe(second);
    });
});
