import { Notice, moment, TFolder, TFile } from 'obsidian';
import { getDailyNote, createDailyNote, getAllDailyNotes } from 'obsidian-daily-notes-interface';
import { notificationUrl, whiteNoiseUrl } from './audio_urls';
import { WhiteNoise } from './white_noise';
import { PomoSettings } from './settings';
import PomoTimerPlugin from './main';

const electron = require("electron");

const MILLISECS_IN_MINUTE = 60 * 1000;

export const enum Mode {
	Pomo,
	ShortBreak,
	LongBreak,
	NoTimer
}


export class Timer {
	metaEdit: any;
	plugin: PomoTimerPlugin;
	settings: PomoSettings;
	startTime: moment.Moment; /*when currently running timer started*/
	endTime: moment.Moment;   /*when currently running timer will end if not paused*/
	restarted: boolean; /*if true, timer is restarted after a pause*/
	mode: Mode;
	pausedTime: number;  /*time left on paused timer, in milliseconds*/
	paused: boolean;
	autoPaused: boolean;
	pomosSinceStart: number;
	cyclesSinceLastAutoStop: number;
	activeNote: TFile;
	whiteNoisePlayer: WhiteNoise;
	
	constructor(plugin: PomoTimerPlugin) {
		this.metaEdit = plugin.app.plugins.plugins['metaedit'].api
		this.plugin = plugin;
		this.settings = plugin.settings;
		this.mode = Mode.NoTimer;
		this.paused = false;
		this.pomosSinceStart = 0;
		this.cyclesSinceLastAutoStop = 0;
		this.restarted = false;

		if (this.settings.whiteNoise === true) {
			this.whiteNoisePlayer = new WhiteNoise(plugin, whiteNoiseUrl);
		}
	}

	onRibbonIconClick() {
		if (this.mode === Mode.NoTimer) {  //if starting from not having a timer running/paused
			this.startTimer(Mode.Pomo);
		} else { //if timer exists, pause or unpause
			this.togglePause();
		}
	}

	/*Set status bar to remaining time or empty string if no timer is running*/
	//handling switching logic here, should spin out
	async setStatusBarText(): Promise<string> {
		if (this.mode !== Mode.NoTimer) {
			let timer_type_symbol = "";
			if (this.settings.emoji === true) {
				timer_type_symbol = "🏖️ ";
				if (this.mode === Mode.Pomo) {
					timer_type_symbol = "🍅 ";
				}
			}

			if (this.paused === true) {
				return timer_type_symbol + millisecsToString(this.pausedTime); //just show the paused time
			} else if (moment().isSameOrAfter(this.endTime)) {
				await this.handleTimerEnd();
			}

			return timer_type_symbol + millisecsToString(this.getCountdown()); //return display value
		} else {
			return ""; //fixes TypeError: failed to execute 'appendChild' on 'Node https://github.com/kzhovn/statusbar-pomo-obsidian/issues/4
		}
	}

	async handleTimerEnd() {
		if (this.mode === Mode.Pomo) { //completed another pomo
			this.pomosSinceStart += 1;

			if (this.settings.logging === true) {
				await this.logPomo(this.restarted ? '(resumed)' : '');
			}
		} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
			this.cyclesSinceLastAutoStop += 1;
		}

		//switch mode
		if (this.settings.notificationSound === true) { //play sound end of timer
			playNotification();
		}
		if (this.settings.useSystemNotification === true) { //show system notification end of timer
			showSystemNotification(this.mode, this.settings.emoji);
		}

		if (this.settings.autostartTimer === false && this.settings.numAutoCycles <= this.cyclesSinceLastAutoStop) { //if autostart disabled, pause and allow user to start manually
			this.setupTimer();
			this.autoPaused = true;
			this.paused = true;
			this.pausedTime = this.getTotalModeMillisecs();
			this.cyclesSinceLastAutoStop = 0;
		} else {
			this.startTimer();
		}
	}

	async quitTimer(): Promise<void> {
		this.mode = Mode.NoTimer;
		this.startTime = moment(0);
		this.endTime = moment(0);
		this.paused = false;
		this.pomosSinceStart = 0;

		if (this.settings.whiteNoise === true) {
			this.whiteNoisePlayer.stopWhiteNoise();
		}

		await this.plugin.loadSettings(); //why am I loading settings on quit? to ensure that when I restart everything is correct? seems weird
	}

	pauseTimer(): void {
		this.paused = true;
		this.pausedTime = this.getCountdown();

		if (this.settings.whiteNoise === true) {
			this.whiteNoisePlayer.stopWhiteNoise();
		}
	}

	async togglePause() {
		if (this.paused === true) {
			this.restartTimer();
		} else if (this.mode !== Mode.NoTimer) { //if some timer running
			this.pauseTimer();
			this.endTime = moment();
			if (this.settings.logging === true && this.mode === Mode.Pomo) {
				await this.logPomo('(paused)');
			}
			new Notice("Timer paused.")
		}
	}

	restartTimer(): void {
		if (this.autoPaused === true) {
			// this.setLogFile();
			this.autoPaused = false;
		}

		this.setStartAndEndTime(this.pausedTime);
		this.modeRestartingNotification();
		this.paused = false;

		if (this.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
		this.restarted = true;
	}

	startTimer(mode: Mode = null): void {
		if (this.mode == Mode.NoTimer) {
			this.setLogFile()
		}
		this.setupTimer(mode);
		this.paused = false; //do I need this?
		this.modeStartingNotification();

		if (this.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
		this.restarted = false;
	}

	private setupTimer(mode: Mode = null) {
		if (mode === null) { //no arg -> start next mode in cycle
			if (this.mode === Mode.Pomo) {
				if (this.pomosSinceStart % this.settings.longBreakInterval === 0) {
					this.mode = Mode.LongBreak;
				} else {
					this.mode = Mode.ShortBreak;
				}
			} else { //short break, long break, or no timer
				this.mode = Mode.Pomo;
			}
		} else { //starting a specific mode passed to func
			this.mode = mode;
		}

		this.setStartAndEndTime(this.getTotalModeMillisecs());
	}

	setStartAndEndTime(millisecsLeft: number): void {
		this.startTime = moment(); //start time to current time
		this.endTime = moment().add(millisecsLeft, 'milliseconds');
	}

	/*Return milliseconds left until end of timer*/
	getCountdown(): number {
		let endTimeClone = this.endTime.clone(); //rewrite with freeze?
		return endTimeClone.diff(moment());
	}

	getTotalModeMillisecs(): number {
		switch (this.mode) {
			case Mode.Pomo: {
				return this.settings.pomo * MILLISECS_IN_MINUTE;
			}
			case Mode.ShortBreak: {
				return this.settings.shortBreak * MILLISECS_IN_MINUTE;
			}
			case Mode.LongBreak: {
				return this.settings.longBreak * MILLISECS_IN_MINUTE;
			}
			case Mode.NoTimer: {
				throw new Error("Mode NoTimer does not have an associated time value");
			}
		}
	}



	/**************  Notifications  **************/
	/*Sends notification corresponding to whatever the mode is at the moment it's called*/
	modeStartingNotification(): void {
		let time = this.getTotalModeMillisecs();
		let unit: string;

		if (time >= MILLISECS_IN_MINUTE) { /*display in minutes*/
			time = Math.floor(time / MILLISECS_IN_MINUTE);
			unit = 'minute';
		} else { /*less than a minute, display in seconds*/
			time = Math.floor(time / 1000); //convert to secs
			unit = 'second';
		}

		switch (this.mode) {
			case (Mode.Pomo): {
				new Notice(`Starte ${time} ${unit} pomodoro.`);
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				new Notice(`Starting ${time} ${unit} break.`);
				break;
			}
			case (Mode.NoTimer): {
				new Notice('Quitting pomodoro timer.');
				break;
			}
		}
	}

	modeRestartingNotification(): void {
		switch (this.mode) {
			case (Mode.Pomo): {
				new Notice(`Restarting pomodoro.`);
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				new Notice(`Restarting break.`);
				break;
			}
		}
	}

	/**************  Logging  **************/
	async logPomo(comment: string): Promise<void> {
		const dailyNoteFilePath = (await getDailyNoteFile()).path;
		
		const properties = await this.metaEdit.getPropertiesInFile(dailyNoteFilePath);
		const targetProp = 'pomodoros';

		let values
		let property = properties.find(prop => prop.key === targetProp);
		if (property === undefined) {
			console.log('creating new property')
			await this.metaEdit.createYamlProperty(targetProp, '[]', dailyNoteFilePath)
			values = []
		} else {
			values = property.content
		}
		const duration = moment.duration(this.endTime.diff(this.startTime)).asMinutes()
	  const newValues = {
			date: this.startTime.format('YYYY-MM-DD HH:mm:ss'),
			duration: Math.round(duration * 10) / 10,
			link: this.plugin.app.fileManager.generateMarkdownLink(this.activeNote, ''),
			comment: comment,
		}
		values.push(newValues)
		await this.metaEdit.update(targetProp, values, dailyNoteFilePath)
	}

	setLogFile(){
		const activeView = this.plugin.app.workspace.getActiveFile();
		if (activeView) {
			this.activeNote = activeView;
		}
	}
}

/*Returns [HH:]mm:ss left on the current timer*/
function millisecsToString(millisecs: number): string {
	let formattedCountDown: string;

	if (millisecs >= 60 * 60 * 1000) { /* >= 1 hour*/
		formattedCountDown = moment.utc(millisecs).format('HH:mm:ss');
	} else {
		formattedCountDown = moment.utc(millisecs).format('mm:ss');
	}

	return formattedCountDown.toString();
}

function playNotification(): void {
	const audio = new Audio(notificationUrl);
	audio.play();
}

function showSystemNotification(mode:Mode, useEmoji:boolean): void {
	let text = "";
	switch (mode) {
		case (Mode.Pomo): {
			let emoji = useEmoji ? "🏖" : ""
			text = `End of the pomodoro, time to take a break ${emoji}`;
			break;
		}
		case (Mode.ShortBreak):
		case (Mode.LongBreak): {
			let emoji = useEmoji ? "🍅" : ""
			text = `End of the break, time for the next pomodoro ${emoji}`;
			break;
		}
		case (Mode.NoTimer): {
			// no system notification needed
			return;
		}
	}
	let emoji = useEmoji ? "🍅" : ""
	let title = `Obsidian Pomodoro ${emoji}`;

	// Show system notification
	const Notification = (electron as any).remote.Notification;
	const n = new Notification({
		title: title,
		body: text,
		silent: true
	});
	n.on("click", () => {
		n.close();
	});
	n.show();
}

export async function getDailyNoteFile(): Promise<TFile> {
	const file = getDailyNote(moment() as any, getAllDailyNotes()); // as any, because getDailyNote is importing its own Moment and I'm using Obsidian's

	if (!file) {
		return await createDailyNote(moment() as any);
	}

	return file;
}






