import type { DataWin, Sound } from '../data/DataWin.ts';

/** Playing-sound ids start here, so they can't be mistaken for sound asset indices. */
const FIRST_VOICE_ID = 200000;

/**
 * For automated test runs: the same interface, but it never opens the sound device or plays anything,
 * so tests can't be heard and can't affect other apps' audio.
 */
export class SilentAudio {
	private nextId = FIRST_VOICE_ID;
	resume(): void {}
	close(): void {}
	lockMute(): void {}
	setMuted(): void {}
	setVolume(): void {}
	play(): number {
		return this.nextId++;
	}
	stop(): void {}
	stopAll(): void {}
	pause(): void {}
	resumeSound(): void {}
	pauseAll(): void {}
	resumeAll(): void {}
	isPlaying(): boolean {
		return false;
	}
	setGain(): void {}
	getGain(): number {
		return 1;
	}
	setPitch(): void {}
	getPitch(): number {
		return 1;
	}
	getPosition(): number {
		return 0;
	}
	setPosition(): void {}
}

interface Voice {
	id: number;
	sound: Sound;
	gain: GainNode;
	loop: boolean;
	pitch: number;
	paused: boolean;
	ended: boolean;
	/** Embedded sounds play from a decoded buffer. */
	source: AudioBufferSourceNode | null;
	buffer: AudioBuffer | null;
	startedAt: number;
	offset: number;
	/** Music streams through a media element. */
	element: HTMLAudioElement | null;
}

/**
 * GameMaker's audio_* functions on Web Audio. Sound effects are decoded from data.win on first use;
 * music streams from the .ogg files next to it.
 */
export class AudioEngine {
	private readonly data: DataWin;
	private readonly musicUrl: (file: string) => string | null;
	private readonly ctx = new AudioContext();
	private readonly master = this.ctx.createGain();
	private readonly buffers = new Map<number, Promise<AudioBuffer | null>>();
	private readonly voices = new Map<number, Voice>();
	/** audio_sound_gain on an asset scales every instance of it. */
	private readonly assetGain = new Map<number, number>();
	private nextId = FIRST_VOICE_ID;

	constructor(data: DataWin, musicUrl: (file: string) => string | null) {
		this.data = data;
		this.musicUrl = musicUrl;
		this.master.connect(this.ctx.destination);
	}

	/** Browsers start audio suspended until the page has been interacted with. */
	resume(): void {
		if (this.ctx.state === 'suspended') void this.ctx.resume();
	}

	close(): void {
		this.stopAll();
		void this.ctx.close();
	}

	/** Silences everything for good (automated tests); later setMuted calls can't undo it. */
	private muteLocked = false;

	lockMute(): void {
		this.muteLocked = true;
		this.master.gain.value = 0;
		this.master.gain.setValueAtTime(0, this.ctx.currentTime);
	}

	/** Muting (while skipping) and the player's volume combine: unmuting restores the volume. */
	private muted = false;
	private volume = 1;

	setMuted(muted: boolean): void {
		this.muted = muted;
		this.applyGain();
	}

	/** The player's volume, 0 to 1. */
	setVolume(volume: number): void {
		this.volume = Math.min(1, Math.max(0, volume));
		this.applyGain();
	}

	private applyGain(): void {
		if (this.muteLocked) return;
		this.master.gain.setValueAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime);
	}

	play(soundIndex: number, loop: boolean): number {
		const sound = this.data.sounds[soundIndex];
		if (!sound) return -1;
		const gain = this.ctx.createGain();
		gain.gain.value = sound.volume * (this.assetGain.get(soundIndex) ?? 1);
		gain.connect(this.master);
		const voice: Voice = {
			id: this.nextId++,
			sound,
			gain,
			loop,
			pitch: sound.pitch || 1,
			paused: false,
			ended: false,
			source: null,
			buffer: null,
			startedAt: this.ctx.currentTime,
			offset: 0,
			element: null,
		};
		this.voices.set(voice.id, voice);

		if (sound.audioId >= 0) {
			void this.decode(sound).then((buffer) => {
				if (!buffer || voice.ended) return;
				voice.buffer = buffer;
				if (!voice.paused) this.startBuffer(voice, 0);
			});
		} else {
			const url = this.musicUrl(sound.file);
			if (!url) {
				// Missing from the install: the voice ends at once, as a sound that failed to load.
				this.finish(voice);
				return voice.id;
			}
			const el = new Audio(url);
			el.loop = loop;
			el.preservesPitch = false;
			el.playbackRate = voice.pitch;
			el.addEventListener('ended', () => {
				if (!voice.loop) this.finish(voice);
			});
			this.ctx.createMediaElementSource(el).connect(gain);
			voice.element = el;
			void el.play().catch(() => undefined);
		}
		return voice.id;
	}

	stop(id: number): void {
		for (const v of this.matching(id)) this.finish(v);
	}

	stopAll(): void {
		for (const v of [...this.voices.values()]) this.finish(v);
	}

	pause(id: number): void {
		for (const v of this.matching(id)) this.pauseVoice(v);
	}

	resumeSound(id: number): void {
		for (const v of this.matching(id)) this.resumeVoice(v);
	}

	pauseAll(): void {
		for (const v of this.voices.values()) this.pauseVoice(v);
	}

	resumeAll(): void {
		for (const v of this.voices.values()) this.resumeVoice(v);
	}

	isPlaying(id: number): boolean {
		return this.matching(id).some((v) => !v.ended && !v.paused);
	}

	setGain(id: number, gain: number, timeMs: number): void {
		const end = this.ctx.currentTime + Math.max(0, timeMs) / 1000;
		if (id < FIRST_VOICE_ID) this.assetGain.set(id, gain);
		for (const v of this.matching(id)) {
			const target = v.sound.volume * gain;
			v.gain.gain.cancelScheduledValues(this.ctx.currentTime);
			v.gain.gain.setValueAtTime(v.gain.gain.value, this.ctx.currentTime);
			if (timeMs > 0) v.gain.gain.linearRampToValueAtTime(target, end);
			else v.gain.gain.setValueAtTime(target, this.ctx.currentTime);
		}
	}

	getGain(id: number): number {
		const v = this.matching(id)[0];
		if (v) return v.gain.gain.value / (v.sound.volume || 1);
		return this.assetGain.get(id) ?? 1;
	}

	setPitch(id: number, pitch: number): void {
		for (const v of this.matching(id)) {
			v.offset = this.position(v);
			v.startedAt = this.ctx.currentTime;
			v.pitch = pitch;
			if (v.source) v.source.playbackRate.value = pitch;
			if (v.element) v.element.playbackRate = pitch;
		}
	}

	getPitch(id: number): number {
		return this.matching(id)[0]?.pitch ?? 1;
	}

	getPosition(id: number): number {
		const v = this.matching(id)[0];
		return v ? this.position(v) : 0;
	}

	setPosition(id: number, seconds: number): void {
		for (const v of this.matching(id)) {
			if (v.element) v.element.currentTime = seconds;
			else if (v.buffer && !v.paused) this.startBuffer(v, seconds);
			else v.offset = seconds;
		}
	}

	private matching(id: number): Voice[] {
		if (id >= FIRST_VOICE_ID) {
			const v = this.voices.get(id);
			return v ? [v] : [];
		}
		return [...this.voices.values()].filter((v) => v.sound.index === id);
	}

	private position(v: Voice): number {
		if (v.element) return v.element.currentTime;
		if (v.paused || !v.source) return v.offset;
		const t = v.offset + (this.ctx.currentTime - v.startedAt) * v.pitch;
		return v.buffer && v.loop ? t % v.buffer.duration : t;
	}

	private startBuffer(v: Voice, offset: number): void {
		if (v.source) {
			v.source.onended = null;
			v.source.stop();
		}
		const src = this.ctx.createBufferSource();
		src.buffer = v.buffer;
		src.loop = v.loop;
		src.playbackRate.value = v.pitch;
		src.connect(v.gain);
		src.onended = () => {
			if (!v.loop && v.source === src && !v.paused) this.finish(v);
		};
		src.start(0, Math.max(0, offset) % (v.buffer?.duration || 1));
		v.source = src;
		v.offset = offset;
		v.startedAt = this.ctx.currentTime;
	}

	private pauseVoice(v: Voice): void {
		if (v.paused || v.ended) return;
		v.offset = this.position(v);
		v.paused = true;
		if (v.element) v.element.pause();
		if (v.source) {
			v.source.onended = null;
			v.source.stop();
			v.source = null;
		}
	}

	private resumeVoice(v: Voice): void {
		if (!v.paused || v.ended) return;
		v.paused = false;
		if (v.element) void v.element.play().catch(() => undefined);
		else if (v.buffer) this.startBuffer(v, v.offset);
	}

	private finish(v: Voice): void {
		if (v.ended) return;
		v.ended = true;
		if (v.source) {
			v.source.onended = null;
			v.source.stop();
		}
		if (v.element) {
			v.element.pause();
			v.element.removeAttribute('src');
		}
		v.gain.disconnect();
		this.voices.delete(v.id);
	}

	private decode(sound: Sound): Promise<AudioBuffer | null> {
		let pending = this.buffers.get(sound.audioId);
		if (!pending) {
			const bytes = this.data.audio[sound.audioId];
			pending = bytes
				? this.ctx.decodeAudioData(bytes.slice().buffer).catch((err: unknown) => {
						console.warn(`Could not decode ${sound.name}`, err);
						return null;
					})
				: Promise.resolve(null);
			this.buffers.set(sound.audioId, pending);
		}
		return pending;
	}
}
