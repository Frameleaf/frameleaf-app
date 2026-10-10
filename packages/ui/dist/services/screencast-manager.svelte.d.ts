declare class ScreencastManager {
    #private;
    get cursor(): {
        event: MouseEvent;
        moving: boolean;
    } | undefined;
    get events(): KeyboardEvent[];
    get enabled(): boolean;
    toggle(): void;
    onTick(): void;
    onKeyDown(event: KeyboardEvent): void;
    onMouseDown(event: MouseEvent): void;
    onMouseMove(event: MouseEvent): void;
    onMouseUp(_event: MouseEvent): void;
}
export declare const screencastManager: ScreencastManager;
export {};
