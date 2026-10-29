# Gen City Auto

Make a Spiderman PS5, GTA5 inspired game where you drive car around a metropolis
using WebGPU with no libraries. Use the latest typescript, esbuild, gts the work together
and have a github action to publish on github pages. Use WebGPU best practices.

The buildings, trees, stop lights, parks, ads, billboards, signs, cars, busses, trucks, helicopters,
vehicle interiors should all be procedurally generated. The idea is let the user
casually drive or fly around the city.

The city should be enormous like Tokyo or New York City or Chongqing or Hong Kong,
have waterfronts, bridges, not be on a grid though parts of it can be.

Use NURBS to make the vehicles. Consider making a NURBS api and give it to another
agent to design the vehicles and a 3rd agent to judge. You will need to display
lots of vehicles.

It should look amazing! Like GTA5 and Spiderman PS5
It should use techniques from AAA games to both look amazing and to keep the frame rate up.
Consider using techniques like those from Unreal Nanite, if appropriate. Games like
Ratchet and Clank, Spiderman, GTA5, Cyberpunk 2027 all manage to draw very large detailed
cities and keep a good framerate. Render no more than CSS resolution, no devicePixelRatio
adjustment for now.

It should support multiple types of cities so the user can generate a new city.
It should support time of day with beautiful clouds, rayleigh scatting, night time.
Buildings, street lights, signs, will need to look correct for day or night.
It should also support weather so sunny days, cloudy days, rainy days, stormy days.
The roads and sidewalks should appear wet on those says

The user should be able to switch the camera to multiple modes. At least chase camera
and first person when in the car. The current vehicle should drive itself when
the user is not controlling it and the camera should have an auto director when
the user is not driving the vehicle.

The project can be tested with puppeteer, no special arguments are needed. If serving
the page use express for local testing. Be sure to label all WebGPU objects,
and print webgpu uncapturederror events so that you will know when WebGPU has failed
and from the labels, be able to figure out where the issue is.

Have at least one agent who's sole duty is to judge if the result matches AAA
games.
