// Two behaviours, and the page reads without either: copy buttons and the recipe tabs.
(function () {
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
    // An older browser, or a page not served over HTTPS.
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea")
      area.value = text
      area.setAttribute("readonly", "")
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.appendChild(area)
      area.select()
      var ok = false
      try {
        ok = document.execCommand("copy")
      } catch (error) {}
      document.body.removeChild(area)
      ok ? resolve() : reject(new Error("copy failed"))
    })
  }

  document.querySelectorAll("[data-copy], [data-copy-from]").forEach(function (button) {
    var label = button.querySelector(".btn__label") || button
    var original = label.innerHTML
    var timer = null
    button.addEventListener("click", function () {
      var from = button.getAttribute("data-copy-from")
      var text = from ? document.getElementById(from).textContent : button.getAttribute("data-copy")
      // A shorter label must not shrink the button: beside another button it would jump to that one's line.
      if (!button.style.minWidth) button.style.minWidth = button.getBoundingClientRect().width + "px"
      copy(text).then(
        function () {
          button.classList.add("is-done")
          label.textContent = button.getAttribute("data-done") || "Copied"
        },
        function () {
          label.textContent = "Select the text and copy it"
        },
      ).then(function () {
        clearTimeout(timer)
        timer = setTimeout(function () {
          button.classList.remove("is-done")
          label.innerHTML = original
          button.style.minWidth = ""
        }, 2400)
      })
    })
  })

  document.querySelectorAll("[data-tabs]").forEach(function (root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'))
    function select(tab, focus) {
      tabs.forEach(function (other) {
        var on = other === tab
        other.setAttribute("aria-selected", on ? "true" : "false")
        other.tabIndex = on ? 0 : -1
        document.getElementById(other.getAttribute("aria-controls")).hidden = !on
      })
      if (focus) tab.focus()
    }
    tabs.forEach(function (tab, index) {
      tab.addEventListener("click", function () {
        select(tab, false)
      })
      tab.addEventListener("keydown", function (event) {
        var next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null
        if (next === null) return
        event.preventDefault()
        select(tabs[(next + tabs.length) % tabs.length], true)
      })
    })
  })
})()
