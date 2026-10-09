package main

import (
	"net/http"
)

func routes() *http.ServeMux {
	m := http.NewServeMux()

	authRoutes(m)
	userRoutes(m)
	postRoutes(m)
	homeworkRoutes(m)
	adminRoutes(m)

	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, "Not found")
	})

	m.HandleFunc("/", static)

	return m
}

func authRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/config", config)
	m.HandleFunc("GET /api/auth/nonce", nonce)

	m.HandleFunc(
		"POST /api/auth/telegram",
		limited(telegramLogin),
	)
	m.HandleFunc(
		"POST /api/auth/dev",
		limited(devLogin),
	)
	m.HandleFunc(
		"POST /api/auth/logout",
		logout,
	)

	m.HandleFunc(
		"GET /api/me",
		authed(me),
	)
	m.HandleFunc(
		"PATCH /api/me",
		authed(updateMe),
	)
}

func userRoutes(m *http.ServeMux) {
	m.HandleFunc(
		"GET /api/users",
		authed(listUsers),
	)
	m.HandleFunc(
		"GET /api/users/{id}",
		authed(getUser),
	)
	m.HandleFunc(
		"GET /api/schedule",
		authed(schedule),
	)
}

func postRoutes(m *http.ServeMux) {
	m.HandleFunc(
		"GET /api/posts",
		authed(listPosts),
	)
	m.HandleFunc(
		"POST /api/posts",
		admin(createPost),
	)
	m.HandleFunc(
		"PATCH /api/posts/{id}",
		admin(pinPost),
	)
	m.HandleFunc(
		"DELETE /api/posts/{id}",
		admin(deletePost),
	)
}

func homeworkRoutes(m *http.ServeMux) {
	m.HandleFunc(
		"GET /api/homework",
		authed(listHomework),
	)
	m.HandleFunc(
		"PUT /api/homework",
		moderator(saveHomework),
	)
	m.HandleFunc(
		"POST /api/homework/files",
		moderator(uploadFile),
	)
	m.HandleFunc(
		"GET /api/homework/files/{id}",
		authed(downloadFile),
	)
	m.HandleFunc(
		"DELETE /api/homework/files/{id}",
		moderator(deleteFile),
	)
	m.HandleFunc(
		"PATCH /api/homework/files/{id}",
		moderator(saveFileNote),
	)
	m.HandleFunc(
		"POST /api/homework/files/{id}/attach",
		moderator(attachFile),
	)
	m.HandleFunc(
		"PUT /api/teachers",
		moderator(saveTeacher),
	)
	m.HandleFunc(
		"GET /api/materials",
		authed(listMaterials),
	)
	m.HandleFunc(
		"POST /api/materials",
		moderator(createMaterial),
	)
	m.HandleFunc(
		"DELETE /api/materials/{id}",
		moderator(deleteMaterial),
	)
}

func adminRoutes(m *http.ServeMux) {
	m.HandleFunc(
		"GET /api/admin/invites",
		admin(listInvites),
	)
	m.HandleFunc(
		"POST /api/admin/invites",
		admin(createInvite),
	)
	m.HandleFunc(
		"DELETE /api/admin/invites/{code}",
		admin(deleteInvite),
	)

	m.HandleFunc(
		"GET /api/admin/users",
		admin(listUsers),
	)
	m.HandleFunc(
		"PATCH /api/admin/users/{id}",
		admin(setRole),
	)
	m.HandleFunc(
		"DELETE /api/admin/users/{id}",
		admin(deleteUser),
	)

	m.HandleFunc(
		"POST /api/admin/ocr",
		moderator(ocrSheet),
	)
	m.HandleFunc(
		"GET /api/admin/ocr/aliases",
		moderator(listOcrAliases),
	)
	m.HandleFunc(
		"PUT /api/admin/ocr/aliases",
		moderator(saveOcrAliases),
	)
	m.HandleFunc(
		"PUT /api/admin/schedule",
		moderator(saveSchedule),
	)
	m.HandleFunc(
		"PUT /api/admin/schedule/week",
		moderator(saveWeek),
	)
	m.HandleFunc(
		"PUT /api/admin/pair-times",
		admin(savePairTimes),
	)
	m.HandleFunc(
		"PUT /api/admin/settings",
		admin(saveSettings),
	)
}
