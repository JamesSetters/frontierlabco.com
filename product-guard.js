(function() {
  const PRODUCT_PASSWORD = "Product0001??";

  function handleProductClick(event) {
    event.preventDefault();
    const answer = window.prompt("Enter the Product password:");
    if (answer === null) {
      return;
    }
    if (answer === PRODUCT_PASSWORD) {
      window.location.href = event.currentTarget.getAttribute("href") || "shop.html";
    } else {
      window.alert("Incorrect password. Please try again.");
    }
  }

  document.addEventListener("DOMContentLoaded", function() {
    const links = document.querySelectorAll("[data-product-link]");
    links.forEach(link => {
      link.addEventListener("click", handleProductClick);
    });
  });
})();
