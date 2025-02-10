function handleSubmit(event) {
    event.preventDefault();
    var responseInput = document.querySelector('input[name="response"]');
    var remarkInput = document.querySelector('textarea[name="remark"]');
    var messageBox = document.getElementById("message");
    var submitButton = document.querySelector('button[type="submit"]');

    if (!responseInput.value.trim()) {
        messageBox.innerText = "⚠️入力欄が空です。";
        messageBox.style.color = "red";
        return;
    }

    submitButton.disabled = true;
    setTimeout(() => { submitButton.disabled = false; }, 10000);

    messageBox.innerHTML = "✅送信が完了しました！<br>リクエストありがとうございました！";
    messageBox.style.color = "green";

    event.target.submit();
    responseInput.value = "";
    remarkInput.value = "";
}
