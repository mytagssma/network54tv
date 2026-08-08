// Screen Orientation API — lock/unlock for fullscreen landscape
interface ScreenOrientation {
  lock(orientation: OrientationLockType): Promise<void>;
  unlock(): void;
}
