-- Hermes emulator-catalog bridge for mGBA (Lua scripting API, mGBA >= 0.10).
-- Listens on 127.0.0.1 only. Line protocol, one request per line:
--   <id> <token> <command> [args...]\n
-- Replies:
--   <id> OK [payload]\n   or   <id> ERR <message>\n
-- Template placeholders (filled in by the plugin before launch): PORT, TOKEN.

local PORT = tonumber("{{PORT}}")
local TOKEN = "{{TOKEN}}"

local KEYS = { A = 0, B = 1, SELECT = 2, START = 3, RIGHT = 4, LEFT = 5, UP = 6, DOWN = 7, R = 8, L = 9 }

local server = nil
local clients = {}
local buffers = {}
local nextClient = 1
-- Queue of timed jobs (press / wait). Only the head job runs; replies are sent when it finishes.
local jobs = {}

local function reply(sock, id, ok, payload)
	local line = id .. (ok and " OK" or " ERR")
	if payload and payload ~= "" then line = line .. " " .. payload end
	sock:send(line .. "\n")
end

local function tohex(s)
	return (s:gsub(".", function(c) return string.format("%02x", string.byte(c)) end))
end

local function keymask(spec)
	local mask = 0
	for name in string.gmatch(spec, "[^,+]+") do
		local bit = KEYS[string.upper(name)]
		if bit == nil then return nil, "unknown key " .. name end
		mask = mask | (1 << bit)
	end
	return mask
end

local function needGame(sock, id)
	if not emu then
		reply(sock, id, false, "no game loaded")
		return false
	end
	return true
end

local handlers = {}

function handlers.ping(sock, id, args)
	local title = emu and emu:getGameTitle() or ""
	local code = emu and emu:getGameCode() or ""
	local platform = emu and emu:platform() or -1
	local frame = emu and emu:currentFrame() or 0
	reply(sock, id, true, string.format("platform=%d frame=%d code=%s title=%s", platform, frame, code, title))
end

function handlers.press(sock, id, args)
	if not needGame(sock, id) then return end
	local mask, err = keymask(args[1] or "")
	if not mask then return reply(sock, id, false, err) end
	local hold = math.max(1, math.min(tonumber(args[2] or "8") or 8, 600))
	local wait = math.max(0, math.min(tonumber(args[3] or "12") or 12, 3600))
	table.insert(jobs, { kind = "press", sock = sock, id = id, mask = mask, hold = hold, wait = wait, started = false })
end

function handlers.wait(sock, id, args)
	if not needGame(sock, id) then return end
	local frames = math.max(1, math.min(tonumber(args[1] or "60") or 60, 36000))
	table.insert(jobs, { kind = "wait", sock = sock, id = id, mask = 0, hold = 0, wait = frames, started = false })
end

function handlers.screenshot(sock, id, args)
	if not needGame(sock, id) then return end
	local path = table.concat(args, " ")
	if path == "" then return reply(sock, id, false, "path required") end
	emu:screenshot(path)
	reply(sock, id, true, path)
end

function handlers.save(sock, id, args)
	if not needGame(sock, id) then return end
	local path = table.concat(args, " ")
	if path == "" then return reply(sock, id, false, "path required") end
	local ok = emu:saveStateFile(path, 31)
	reply(sock, id, ok, ok and path or "saveStateFile failed")
end

function handlers.load(sock, id, args)
	if not needGame(sock, id) then return end
	local path = table.concat(args, " ")
	if path == "" then return reply(sock, id, false, "path required") end
	local ok = emu:loadStateFile(path, 29)
	reply(sock, id, ok, ok and path or "loadStateFile failed")
end

function handlers.read(sock, id, args)
	if not needGame(sock, id) then return end
	local addr = tonumber(args[1] or "")
	local len = tonumber(args[2] or "")
	if not addr or not len then return reply(sock, id, false, "usage: read <addr> <len>") end
	if len < 1 or len > 4096 then return reply(sock, id, false, "len must be 1..4096") end
	reply(sock, id, true, tohex(emu:readRange(addr, len)))
end

function handlers.reset(sock, id, args)
	if not needGame(sock, id) then return end
	emu:reset()
	reply(sock, id, true, "")
end

local function dispatch(sock, line)
	local parts = {}
	for word in string.gmatch(line, "%S+") do table.insert(parts, word) end
	local id, token, cmd = parts[1], parts[2], parts[3]
	if not id or not cmd then return end
	if token ~= TOKEN then return reply(sock, id, false, "bad token") end
	local fn = handlers[cmd]
	if not fn then return reply(sock, id, false, "unknown command " .. cmd) end
	local args = {}
	for i = 4, #parts do table.insert(args, parts[i]) end
	local ok, err = pcall(fn, sock, id, args)
	if not ok then reply(sock, id, false, tostring(err)) end
end

local function onReceived(cid)
	local sock = clients[cid]
	if not sock then return end
	while true do
		local data, err = sock:receive(4096)
		if data then
			buffers[cid] = (buffers[cid] or "") .. data
			while true do
				local nl = string.find(buffers[cid], "\n", 1, true)
				if not nl then break end
				local line = string.sub(buffers[cid], 1, nl - 1):gsub("\r$", "")
				buffers[cid] = string.sub(buffers[cid], nl + 1)
				dispatch(sock, line)
			end
		else
			if err ~= socket.ERRORS.AGAIN then
				clients[cid] = nil
				buffers[cid] = nil
				sock:close()
			end
			return
		end
	end
end

local function onAccept()
	local sock, err = server:accept()
	if err or not sock then return end
	local cid = nextClient
	nextClient = cid + 1
	clients[cid] = sock
	sock:add("received", function() onReceived(cid) end)
	sock:add("error", function() clients[cid] = nil; sock:close() end)
end

local function onFrame()
	local job = jobs[1]
	if not job or not emu then return end
	if not job.started then
		job.started = true
		if job.mask ~= 0 then emu:addKeys(job.mask) end
	end
	if job.hold > 0 then
		job.hold = job.hold - 1
		if job.hold == 0 and job.mask ~= 0 then emu:clearKeys(job.mask) end
		return
	end
	if job.wait > 0 then
		job.wait = job.wait - 1
		return
	end
	table.remove(jobs, 1)
	reply(job.sock, job.id, true, "frame=" .. emu:currentFrame())
end

callbacks:add("frame", onFrame)

local err
server, err = socket.bind("127.0.0.1", PORT)
if not server then
	console:error("hermes bridge: bind failed: " .. tostring(err))
else
	local _, lerr = server:listen()
	if lerr then
		console:error("hermes bridge: listen failed: " .. tostring(lerr))
	else
		server:add("received", onAccept)
		console:log("hermes bridge: listening on 127.0.0.1:" .. PORT)
	end
end
