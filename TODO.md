[x] rain drops are going the wrong way and don't look much like rain but instead look like vertical rectangles
    -> fixed: drops moved upward (sign bug); now thin motion-blurred streaks of varying length, denser.

[x] water distortion only makes sense inside the car and should be limited to the windows.
    Currently it's a fullscreen effect that is always on
    -> lens drops are disabled; rain beads stay on the car glass only.

[x] the vehicles flicker often, almost but not quite like z-fighting. You can see this right
    at the start just a 5 or 10 seconds into the video. The camera pops outside the car
    as it pulls up to red light, the car in front of it is flickering like crazy.
    -> LOD selection now has hysteresis (vehicles near an LOD distance flipped every frame). Please re-check.

[x] the settings should be in a popup behind a gear icon
[x] the camera should have a camera icon outside the settings the cycles through camera modes
    (can keep camera setting inside the settings too)
[x] the vehicle should have a icon outside the settings that cycles through vehicles.
    -> toolbar top-right: 📷 cycles director -> chase -> first -> hood -> orbit -> free, 🚗 next vehicle,
       ⚙ opens the settings (hidden by default). Camera select in settings includes "free".

[ ] the sky looks really boring for some reason - colors too solid? no stars at night? not sure why.
    Ask the art director?

[ ] Car collisions are poor. Cars z-clip into hills - this happens in the current demo
    right at the start. The car is half under the ground.

[ ] Horizon colors do that match fog colors so when you can see the horizon, like from the helicopter,
    there is a sharp contrast between the horizon/sky-box and the buildings/ground

[ ] The buildings need more details. They need stronger textures or something.

[x] the transit tracks sometimes collide with each other. Even if one is over the other
    it needs to be high enough to allow the train below to pass through with power cables.
    -> crossing elevated lines: the later one rises to clear the other by 8.5 m with a 3% approach grade.

[ ] transit trains need windows and doors. Maybe the windows can use similar tech to building windows.

[x] A production build should
    -> npm run build:prod: minified JS, WGSL stripped of comments/whitespace, gzip size table printed.

    1. strip whitespace from shader source
    2. terser the javascript
    3. print a total for the html/css/js gzipped

    A development build can do none of that.

[ ] Cities usually have some major roads and highways

[ ] When viewing from high up or when the view distance is far, consider showing
    headlight and brake lights as single sprites with no car, especially on highways?
    Same for street lights. I'm not sure if GTA5 does this but it worked well in older
    games.

[x] Tall buildings, antenna, need red airplane lights.
    -> blinking red obstruction lights on the corners of roofs over 60 m.

[x] Lit rooms on buildings are a little too random - I feel like in the real world,
    most buildings light up in sections, 3 floors are like, half a floor is lit.
    A hotel might have random rooms lit but probably fewer than 15%. Or at least
    that's my recollection. Not always though. I'm not actually sure. I just know
    something looks off.
    -> offices light in sections (3 floors x ~20 m: one tenant working late); homes room by room.

[x] Can we add a free camera mode where the user can fly the camera. ASWD moves the camera
    left/right/forward/back, mouse aims. Need mobile controls too. This will make it easier
    to inspect the city. Further, add a button in settings that puts a URL in the clipboard
    that contains the camera's current position, orientation, time-of-day and other things
    so that I can give you that URL to highlight certain places.
    -> free camera: WASD/arrows move, Space/E up, Shift/Q down, right Shift = 4x, mouse drag looks,
       wheel changes speed. Touch: left half of the screen is a move stick, right half looks.
       The car keeps driving on autopilot. "Copy link to this view" in settings (or L) copies a URL
       with freecam=x,y,z,yaw,pitch, time, timespeed=0, weather, city and seed; opening it starts in free camera.

[x] Add size=<width>x<height> url param that lets me set the size of the canvas to a fixed
    number of CSS pixels. i can use this to make videos of a specific size.
    -> added: ?size=1280x720

[x] the height of the camera when inside a vehicle, or a least the default car, seems
    10-20 cm too low.
    -> first-person eye raised 15 cm.

[x] traffic jams are common. All the cars get stuck.
    -> junction deadlock breaker (creep after 4 s stopped), cars stuck > 40 s despawn.